/**
 * SpaceStage — Official Shopify Shop MCP Server-Side Client
 *
 * === DISCOVERY NOTES (verified live against https://mcp.shop.com/) ===
 * Docs inspected:
 *   - https://shopify.dev/docs/agents/shop-mcp
 *   - https://shop.dev/docs/checkout
 *   - https://mcp.shop.com/skill.md
 *
 * Live protocol discovery (POST https://mcp.shop.com/):
 *   - Transport: Stateless JSON-RPC 2.0 over HTTP POST (no persistent session handshake).
 *   - Negotiated protocol version: "2026-07-28" (older versions return -32022 with
 *     supported: ["2026-07-28"]).
 *   - Required HTTP headers:
 *       Content-Type: application/json
 *       Accept: application/json, text/event-stream
 *       MCP-Protocol-Version: 2026-07-28
 *       Mcp-Method: <json-rpc method, e.g. "tools/list" | "tools/call">
 *       Mcp-Name: <tool name>  (required when Mcp-Method is "tools/call")
 *   - Required params._meta on every request:
 *       {
 *         "io.modelcontextprotocol/protocolVersion": "2026-07-28",
 *         "io.modelcontextprotocol/clientCapabilities": {}
 *       }
 *   - Response header `x-request-id` is logged for diagnostics; secrets are never logged.
 *
 * Confirmed tools from live `tools/list` (22 tools):
 *   Catalog:  search_catalog, lookup_catalog, get_product
 *   Cart:     create_cart, get_cart, update_cart
 *   Checkout: create_checkout, get_checkout, update_checkout, complete_checkout
 *   Other:    get_order, search_orders, search_locations, lookup_locations,
 *             ask_business, get_account, create_spend_permission,
 *             create_spend_request, get_spend_request, update_spend_request,
 *             cancel_spend_request, complete_spend_request
 *
 * Tools implemented here:
 *   1. `search_catalog` — arguments: { catalog: { query, context, filters?, pagination? } }
 *      Returns `structuredContent.products[]`, each with `variants[]` containing
 *      ISO 4217 minor-unit `price: { amount, currency }`, `seller: { name, domain, url }`,
 *      `availability: { available }`, `media[]`, and canonical `url`.
 *   2. `get_product` — arguments: { catalog: { id, selected?, context } }
 *      Returns `structuredContent.product` with `variants[]` and `options[]`.
 *   3. `lookup_catalog` — arguments: { catalog: { ids, context } }
 *      Batch lookup by product/variant IDs (used to refresh live details & resolve
 *      real sellerDomain/productUrl without fabricating links).
 *   4. `create_cart` — arguments: { shop: sellerDomain, cart: { line_items: [{ item: { id }, quantity }] } }
 *      Returns `structuredContent` with merchant-specific `id`, `continue_url`, `totals[]`, `messages[]`.
 *
 * Auth & safety:
 *   - Anonymous catalog search, get_product, lookup_catalog, and create_cart work without an API key.
 *   - If `process.env.SHOP_MCP_TOKEN` is set in `.env.local`, it is sent server-side as
 *     `Authorization: Bearer <token>` and never exposed to client bundles.
 *   - `complete_checkout` is intentionally NEVER called; buyers always approve checkout
 *     on the merchant's official `continue_url`.
 */

import { ProductRefSchema, type ProductRef } from "@/lib/schema";

const SHOP_MCP_ENDPOINT = process.env.SHOP_MCP_URL ?? "https://mcp.shop.com/";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_TIMEOUT_MS = 15_000;
const TRANSIENT_RETRY_DELAY_MS = 500;

export const DEFAULT_CATALOG_QUERIES = [
  "display shelf",
  "display table",
  "clothing rack",
  "floor lamp",
  "planter",
] as const;

export class ShopMcpError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options?: { status?: number; requestId?: string; details?: unknown }
  ) {
    super(message);
    this.name = "ShopMcpError";
    this.code = code;
    this.status = options?.status ?? 502;
    this.requestId = options?.requestId;
    this.details = options?.details;
  }
}

export interface ProductOptionValue {
  label: string;
  available: boolean;
  exists: boolean;
}

export interface ProductOptionGroup {
  name: string;
  values: ProductOptionValue[];
}

export interface ProductDetailsResult {
  product: ProductRef;
  variants: ProductRef[];
  options: ProductOptionGroup[];
}

export interface MerchantCartLineInput {
  variantId: string;
  quantity: number;
}

export interface MerchantCartResult {
  cartId: string;
  sellerDomain: string;
  cartUrl: string;
  currency?: string;
  subtotalCents?: number;
  totalCents?: number;
  warnings: string[];
}

interface RawMediaItem {
  type?: string;
  url?: string;
  preview?: { url?: string };
}

interface RawSelectedOption {
  name?: string;
  label?: string;
}

interface RawVariant {
  id?: string;
  title?: string;
  sku?: string;
  url?: string;
  price?: {
    amount?: number;
    currency?: string;
  };
  availability?: {
    available?: boolean;
  };
  media?: RawMediaItem[];
  seller?: {
    id?: string;
    name?: string;
    domain?: string;
    url?: string;
  };
  selected_options?: RawSelectedOption[];
  options?: RawSelectedOption[];
}

interface RawOptionGroup {
  name?: string;
  values?: Array<{
    label?: string;
    available?: boolean;
    exists?: boolean;
  }>;
}

interface RawProduct {
  id?: string;
  title?: string;
  media?: RawMediaItem[];
  variants?: RawVariant[];
  options?: RawOptionGroup[];
}

interface RawMessage {
  type?: string;
  code?: string;
  content?: string;
  severity?: string;
}

interface RawMcpToolResponse {
  jsonrpc?: string;
  id?: number | string;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
}

let rpcIdCounter = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function callShopMcpToolOnce<T extends Record<string, unknown>>(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ data: T; requestId?: string }> {
  const id = rpcIdCounter++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": "tools/call",
    "Mcp-Name": toolName,
  };

  // Optional server-side bearer token (never exposed to browser)
  const token = process.env.SHOP_MCP_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(SHOP_MCP_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new ShopMcpError(
      isTimeout ? "SHOP_MCP_TIMEOUT" : "SHOP_MCP_NETWORK_ERROR",
      isTimeout
        ? `Shopify Shop MCP timed out calling ${toolName}.`
        : `Unable to reach Shopify Shop MCP for ${toolName}.`,
      { status: isTimeout ? 504 : 502 }
    );
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (requestId) {
    console.info(`[shopify-mcp] tool=${toolName} status=${response.status} requestId=${requestId}`);
  }

  if (!response.ok) {
    throw new ShopMcpError(
      "SHOP_MCP_HTTP_ERROR",
      `Shopify Shop MCP returned HTTP ${response.status} for ${toolName}.`,
      { status: response.status >= 500 ? 502 : response.status, requestId }
    );
  }

  let payload: RawMcpToolResponse;
  try {
    payload = (await response.json()) as RawMcpToolResponse;
  } catch {
    throw new ShopMcpError(
      "SHOP_MCP_INVALID_JSON",
      `Shopify Shop MCP returned non-JSON response for ${toolName}.`,
      { status: 502, requestId }
    );
  }

  if (payload.error) {
    throw new ShopMcpError(
      "SHOP_MCP_RPC_ERROR",
      payload.error.message ?? `MCP JSON-RPC error calling ${toolName}.`,
      { status: 502, requestId, details: payload.error.data }
    );
  }

  const result = payload.result;
  const structured = (result?.structuredContent ?? {}) as T;

  if (result?.isError) {
    const textMsg = result.content?.find((c) => typeof c.text === "string")?.text;
    const rawMessages = Array.isArray(structured.messages)
      ? (structured.messages as RawMessage[])
      : [];
    const firstMsg = rawMessages.find((m) => typeof m.content === "string")?.content;
    throw new ShopMcpError(
      "SHOP_MCP_TOOL_ERROR",
      firstMsg ?? textMsg ?? `Shopify Shop MCP reported an error for ${toolName}.`,
      { status: 502, requestId, details: structured }
    );
  }

  return { data: structured, requestId };
}

async function callShopMcpTool<T extends Record<string, unknown>>(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ data: T; requestId?: string }> {
  try {
    return await callShopMcpToolOnce<T>(toolName, args);
  } catch (err) {
    const shouldRetry =
      err instanceof ShopMcpError &&
      (err.code === "SHOP_MCP_NETWORK_ERROR" ||
        err.code === "SHOP_MCP_TIMEOUT" ||
        (err.code === "SHOP_MCP_HTTP_ERROR" && isRetryableStatus(err.status)));

    if (!shouldRetry) {
      throw err;
    }

    await sleep(TRANSIENT_RETRY_DELAY_MS);
    return callShopMcpToolOnce<T>(toolName, args);
  }
}

function pickImageUrl(variantMedia?: RawMediaItem[], productMedia?: RawMediaItem[]): string | undefined {
  const candidates = [...(variantMedia ?? []), ...(productMedia ?? [])];
  for (const item of candidates) {
    if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
      return item.url;
    }
    if (typeof item.preview?.url === "string" && /^https?:\/\//i.test(item.preview.url)) {
      return item.preview.url;
    }
  }
  return undefined;
}

function formatVariantTitle(productTitle: string, variant: RawVariant): string {
  const baseTitle =
    typeof variant.title === "string" && variant.title.trim().length > 0
      ? variant.title.trim()
      : productTitle.trim();

  const optionList =
    Array.isArray(variant.selected_options) && variant.selected_options.length > 0
      ? variant.selected_options
      : Array.isArray(variant.options) && variant.options.length > 0
        ? variant.options
        : [];

  if (optionList.length > 0) {
    const optionSummary = optionList
      .map((o) => o.label?.trim())
      .filter((label): label is string => Boolean(label))
      .join(" / ");
    if (optionSummary && !baseTitle.includes(optionSummary)) {
      return `${baseTitle} (${optionSummary})`;
    }
  }

  if (typeof variant.sku === "string" && variant.sku.trim() && !baseTitle.includes(variant.sku.trim())) {
    return `${baseTitle} (${variant.sku.trim()})`;
  }

  return baseTitle;
}

function disambiguateDuplicateVariantTitles(variants: ProductRef[]): ProductRef[] {
  const counts = new Map<string, number>();
  for (const v of variants) {
    const key = `${v.productId}::${v.title}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return variants.map((v) => {
    const key = `${v.productId}::${v.title}`;
    if ((counts.get(key) ?? 0) <= 1) return v;
    const shortId = v.variantId.split("/").pop()?.slice(-4) ?? v.variantId.slice(-4);
    return {
      ...v,
      title: `${v.title} — Variant #${shortId}`,
    };
  });
}

/**
 * Normalizes a Shop MCP product + variant into the shared `ProductRef` schema
 * and validates against `ProductRefSchema` from `@/lib/schema`.
 * Returns `null` if required fields (price, currency, variantId, seller, url) are missing.
 * Never invents or mocks missing values.
 */
function normalizeVariantToProductRef(
  product: RawProduct,
  variant: RawVariant
): ProductRef | null {
  const productId = typeof product.id === "string" ? product.id.trim() : "";
  const variantId = typeof variant.id === "string" ? variant.id.trim() : "";
  const priceAmount = variant.price?.amount;
  const currency = typeof variant.price?.currency === "string" ? variant.price.currency.trim() : "";
  const seller = typeof variant.seller?.name === "string" ? variant.seller.name.trim() : "";
  const sellerDomain =
    typeof variant.seller?.domain === "string" ? variant.seller.domain.trim() : "";
  const productUrl = typeof variant.url === "string" ? variant.url.trim() : "";

  if (
    !productId ||
    !variantId ||
    typeof priceAmount !== "number" ||
    !Number.isFinite(priceAmount) ||
    priceAmount < 0 ||
    !currency ||
    !seller ||
    !sellerDomain ||
    !productUrl
  ) {
    return null;
  }

  const productTitle = typeof product.title === "string" ? product.title : "";
  const title = formatVariantTitle(productTitle, variant);
  if (!title) {
    return null;
  }

  const imageUrl = pickImageUrl(variant.media, product.media);
  const available = variant.availability?.available === true;

  const candidate = {
    productId,
    variantId,
    title,
    seller,
    sellerDomain,
    priceCents: Math.round(priceAmount),
    currency,
    productUrl,
    ...(imageUrl ? { imageUrl } : {}),
    available,
  };

  const validated = ProductRefSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

function normalizeProductsList(rawProducts: RawProduct[]): ProductRef[] {
  const refs: ProductRef[] = [];
  const seenVariantIds = new Set<string>();

  for (const product of rawProducts) {
    if (!Array.isArray(product.variants)) continue;
    for (const variant of product.variants) {
      const normalized = normalizeVariantToProductRef(product, variant);
      if (normalized && !seenVariantIds.has(normalized.variantId)) {
        seenVariantIds.add(normalized.variantId);
        refs.push(normalized);
      }
    }
  }

  return disambiguateDuplicateVariantTitles(refs);
}

/**
 * Search the live Shopify catalog via Shop MCP `search_catalog`.
 * `maxPriceCents` is an inclusive integer minor-unit bound in USD cents.
 */
export async function searchProducts(
  query: string,
  maxPriceCents?: number,
  limit = 10
): Promise<ProductRef[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new ShopMcpError("INVALID_QUERY", "Search query must not be empty.", { status: 400 });
  }

  const catalogArgs: Record<string, unknown> = {
    query: trimmed,
    context: {
      currency: "USD",
      address_country: "US",
    },
    pagination: {
      limit: Math.max(1, Math.min(limit, 20)),
    },
  };

  if (typeof maxPriceCents === "number" && Number.isFinite(maxPriceCents) && maxPriceCents >= 0) {
    catalogArgs.filters = {
      price: {
        max: Math.floor(maxPriceCents),
      },
    };
  }

  const { data } = await callShopMcpTool<{ products?: RawProduct[] }>("search_catalog", {
    catalog: catalogArgs,
  });

  const rawProducts = Array.isArray(data.products) ? data.products : [];
  const normalized = normalizeProductsList(rawProducts);

  if (typeof maxPriceCents === "number" && Number.isFinite(maxPriceCents) && maxPriceCents >= 0) {
    return normalized.filter((item) => item.priceCents <= maxPriceCents);
  }

  return normalized;
}

/**
 * Runs the default SpaceStage fixture/decor queries in parallel and merges unique results.
 */
export async function searchDefaultCatalog(maxPriceCents?: number): Promise<ProductRef[]> {
  const settled = await Promise.allSettled(
    DEFAULT_CATALOG_QUERIES.map((q) => searchProducts(q, maxPriceCents, 4))
  );

  const merged: ProductRef[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      for (const product of outcome.value) {
        if (!seen.has(product.variantId)) {
          seen.add(product.variantId);
          merged.push(product);
        }
      }
    } else {
      lastError = outcome.reason;
    }
  }

  if (merged.length === 0 && lastError) {
    if (lastError instanceof ShopMcpError) throw lastError;
    throw new ShopMcpError(
      "SHOP_MCP_SEARCH_FAILED",
      "All default catalog searches failed.",
      { status: 502 }
    );
  }

  return merged;
}

function normalizeOptionGroups(rawOptions?: RawOptionGroup[]): ProductOptionGroup[] {
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .filter((group): group is RawOptionGroup & { name: string } => typeof group.name === "string")
    .map((group) => ({
      name: group.name,
      values: Array.isArray(group.values)
        ? group.values
            .filter((v): v is { label: string; available?: boolean; exists?: boolean } =>
              typeof v.label === "string"
            )
            .map((v) => ({
              label: v.label,
              available: v.available === true,
              exists: v.exists !== false,
            }))
        : [],
    }));
}

/**
 * Fetches full product details and normalized variants via Shop MCP `get_product`.
 * When `selected` is omitted and the product exposes multiple available option values,
 * also resolves up to 3 additional real variant combinations so callers get real variant choices.
 */
export async function getProduct(
  productId: string,
  selected?: Array<{ name: string; label: string }>
): Promise<ProductDetailsResult> {
  const trimmedId = productId.trim();
  if (!trimmedId) {
    throw new ShopMcpError("INVALID_PRODUCT_ID", "productId is required.", { status: 400 });
  }

  const catalogArgs: Record<string, unknown> = {
    id: trimmedId,
    context: {
      currency: "USD",
      address_country: "US",
    },
  };
  if (selected && selected.length > 0) {
    catalogArgs.selected = selected;
  }

  const { data } = await callShopMcpTool<{ product?: RawProduct }>("get_product", {
    catalog: catalogArgs,
  });

  const rawProduct = data.product;
  if (!rawProduct) {
    throw new ShopMcpError("PRODUCT_NOT_FOUND", `Product ${trimmedId} was not found.`, {
      status: 404,
    });
  }

  const variants = normalizeProductsList([rawProduct]);
  const options = normalizeOptionGroups(rawProduct.options);

  if (!selected && variants.length === 1 && options.length > 0) {
    const primaryOption = options[0];
    const currentSelected = rawProduct.variants?.[0]?.selected_options ?? [];
    const currentPrimaryLabel = currentSelected.find(
      (o) => o.name === primaryOption.name
    )?.label;

    const alternateLabels = primaryOption.values
      .filter((v) => v.exists && v.available && v.label !== currentPrimaryLabel)
      .slice(0, 3);

    if (alternateLabels.length > 0) {
      const altCalls = await Promise.allSettled(
        alternateLabels.map((alt) =>
          callShopMcpTool<{ product?: RawProduct }>("get_product", {
            catalog: {
              id: trimmedId,
              selected: [{ name: primaryOption.name, label: alt.label }],
              context: { currency: "USD", address_country: "US" },
            },
          })
        )
      );

      const seen = new Set(variants.map((v) => v.variantId));
      for (const res of altCalls) {
        if (res.status === "fulfilled" && res.value.data.product) {
          for (const v of normalizeProductsList([res.value.data.product])) {
            if (!seen.has(v.variantId)) {
              seen.add(v.variantId);
              variants.push(v);
            }
          }
        }
      }
    }
  }

  if (variants.length === 0) {
    throw new ShopMcpError(
      "PRODUCT_NO_VALID_VARIANTS",
      `Product ${trimmedId} has no variants with valid price and seller metadata.`,
      { status: 404 }
    );
  }

  const distinctVariants = disambiguateDuplicateVariantTitles(variants);

  return {
    product: distinctVariants[0],
    variants: distinctVariants,
    options,
  };
}

/**
 * Batch lookup of products/variants by ID via Shop MCP `lookup_catalog`.
 * Used to refresh live availability and resolve real `sellerDomain` / `productUrl`.
 */
export async function lookupCatalogByIds(ids: string[]): Promise<ProductRef[]> {
  const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 50);
  if (uniqueIds.length === 0) return [];

  const { data } = await callShopMcpTool<{ products?: RawProduct[] }>("lookup_catalog", {
    catalog: {
      ids: uniqueIds,
      context: {
        currency: "USD",
        address_country: "US",
      },
    },
  });

  const rawProducts = Array.isArray(data.products) ? data.products : [];
  return normalizeProductsList(rawProducts);
}

/**
 * Creates a merchant-specific cart via Shop MCP `create_cart` and returns
 * the official buyer-controlled `continue_url` handoff link.
 * Never completes a purchase automatically.
 */
export async function createMerchantCart(
  sellerDomain: string,
  lines: MerchantCartLineInput[]
): Promise<MerchantCartResult> {
  const shop = sellerDomain.trim();
  if (!shop) {
    throw new ShopMcpError("INVALID_SELLER_DOMAIN", "Merchant domain is required for cart creation.", {
      status: 400,
    });
  }
  if (lines.length === 0) {
    throw new ShopMcpError("EMPTY_CART_LINES", "At least one line item is required.", {
      status: 400,
    });
  }

  const { data } = await callShopMcpTool<{
    id?: string;
    continue_url?: string;
    currency?: string;
    totals?: Array<{ type?: string; amount?: number }>;
    messages?: RawMessage[];
  }>("create_cart", {
    shop,
    cart: {
      line_items: lines.map((line) => ({
        item: { id: line.variantId },
        quantity: line.quantity,
      })),
    },
  });

  const cartId = typeof data.id === "string" ? data.id : "";
  const cartUrl = typeof data.continue_url === "string" ? data.continue_url : "";

  const warnings = Array.isArray(data.messages)
    ? data.messages
        .map((m) => m.content?.trim())
        .filter((msg): msg is string => Boolean(msg))
    : [];

  if (!cartUrl) {
    throw new ShopMcpError(
      "CART_HANDOFF_UNAVAILABLE",
      `Shopify cart creation did not return a checkout/cart URL for ${shop}.`,
      { status: 502, details: { warnings } }
    );
  }

  const subtotal = data.totals?.find((t) => t.type === "subtotal")?.amount;
  const total = data.totals?.find((t) => t.type === "total")?.amount;

  return {
    cartId,
    sellerDomain: shop,
    cartUrl,
    currency: typeof data.currency === "string" ? data.currency : undefined,
    subtotalCents: typeof subtotal === "number" ? Math.round(subtotal) : undefined,
    totalCents: typeof total === "number" ? Math.round(total) : undefined,
    warnings,
  };
}
