import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createMerchantCart,
  lookupCatalogByIds,
  ShopMcpError,
} from "@/lib/shopify";

const CartLineSchema = z.object({
  variantId: z.string().trim().min(1, "variantId is required"),
  seller: z.string().trim().min(1, "seller is required"),
  sellerDomain: z.string().trim().min(1).optional(),
  productUrl: z.string().url().optional(),
  quantity: z.number().int().positive("quantity must be a positive integer"),
});

const CartRequestSchema = z.object({
  lines: z.array(CartLineSchema).min(1, "At least one cart line is required"),
});

interface CartResponseEntry {
  seller: string;
  sellerDomain?: string;
  cartUrl: string | null;
  checkoutUrl?: string | null;
  cartId?: string;
  subtotalCents?: number;
  totalCents?: number;
  currency?: string;
  fallbackProductUrls?: Array<{
    variantId: string;
    quantity: number;
    productUrl: string | null;
  }>;
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  const parsed = CartRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      { status: 400 }
    );
  }

  const lines = parsed.data.lines;
  const warnings: string[] = [];

  // Always refresh live product/variant details via lookup_catalog before cart
  // creation so we verify availability, sellerDomain, and real productUrl.
  // Never fabricate URLs.
  const allVariantIds = Array.from(new Set(lines.map((l) => l.variantId)));

  const catalogByVariantId = new Map<
    string,
    {
      title: string;
      seller: string;
      sellerDomain: string;
      productUrl: string;
      priceCents: number;
      currency: string;
      available: boolean;
    }
  >();

  if (allVariantIds.length > 0) {
    try {
      const lookedUp = await lookupCatalogByIds(allVariantIds);
      for (const item of lookedUp) {
        catalogByVariantId.set(item.variantId, {
          title: item.title,
          seller: item.seller,
          sellerDomain: item.sellerDomain,
          productUrl: item.productUrl,
          priceCents: item.priceCents,
          currency: item.currency,
          available: item.available !== false,
        });
      }
    } catch (err) {
      const reason = err instanceof ShopMcpError ? err.message : "Catalog lookup failed.";
      warnings.push(`Could not refresh live product details before cart creation: ${reason}`);
    }
  }

  for (const line of lines) {
    const refreshed = catalogByVariantId.get(line.variantId);
    if (refreshed && !refreshed.available) {
      warnings.push(
        `"${refreshed.title}" (${refreshed.seller}) is currently out of stock and may not be added to cart.`
      );
    }
  }

  // Group lines by merchant (carts are strictly merchant-specific).
  const merchantGroups = new Map<
    string,
    {
      seller: string;
      sellerDomain?: string;
      quantitiesByVariant: Map<string, { quantity: number; productUrl: string | null }>;
    }
  >();

  for (const line of lines) {
    const lookedUp = catalogByVariantId.get(line.variantId);
    const resolvedDomain =
      line.sellerDomain ??
      (looksLikeDomain(line.seller) ? line.seller : lookedUp?.sellerDomain);
    const resolvedSeller = lookedUp?.seller ?? line.seller;
    const resolvedProductUrl = line.productUrl ?? lookedUp?.productUrl ?? null;

    const groupKey = (resolvedDomain ?? resolvedSeller).toLowerCase();
    let group = merchantGroups.get(groupKey);
    if (!group) {
      group = {
        seller: resolvedSeller,
        sellerDomain: resolvedDomain,
        quantitiesByVariant: new Map(),
      };
      merchantGroups.set(groupKey, group);
    }

    const existing = group.quantitiesByVariant.get(line.variantId);
    if (existing) {
      existing.quantity += line.quantity;
      if (!existing.productUrl && resolvedProductUrl) {
        existing.productUrl = resolvedProductUrl;
      }
    } else {
      group.quantitiesByVariant.set(line.variantId, {
        quantity: line.quantity,
        productUrl: resolvedProductUrl,
      });
    }
  }

  const carts: CartResponseEntry[] = [];

  for (const group of merchantGroups.values()) {
    const groupLines = Array.from(group.quantitiesByVariant.entries()).map(
      ([variantId, info]) => ({
        variantId,
        quantity: info.quantity,
        productUrl: info.productUrl,
      })
    );

    if (!group.sellerDomain) {
      warnings.push(
        `Cart creation is unavailable for "${group.seller}" because no Shopify store domain could be verified. Use the external product links below to review items directly.`
      );
      carts.push({
        seller: group.seller,
        cartUrl: null,
        checkoutUrl: null,
        fallbackProductUrls: groupLines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          productUrl: l.productUrl,
        })),
      });
      continue;
    }

    try {
      const created = await createMerchantCart(
        group.sellerDomain,
        groupLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))
      );

      for (const w of created.warnings) {
        warnings.push(`${group.seller}: ${w}`);
      }

      carts.push({
        seller: group.seller,
        sellerDomain: created.sellerDomain,
        cartUrl: created.cartUrl,
        checkoutUrl: created.cartUrl,
        cartId: created.cartId,
        subtotalCents: created.subtotalCents,
        totalCents: created.totalCents,
        currency: created.currency,
      });
    } catch (err) {
      const reason =
        err instanceof ShopMcpError
          ? err.message
          : "Shopify cart creation is currently unavailable for this merchant.";

      warnings.push(
        `Cart creation unavailable for "${group.seller}" (${reason}). Review the verified product link(s) directly; no checkout was created or completed.`
      );

      carts.push({
        seller: group.seller,
        sellerDomain: group.sellerDomain,
        cartUrl: null,
        checkoutUrl: null,
        fallbackProductUrls: groupLines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          productUrl: l.productUrl,
        })),
      });
    }
  }

  return NextResponse.json({ carts, warnings });
}
