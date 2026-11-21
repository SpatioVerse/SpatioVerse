"use client";

/**
 * SpaceStage — ProductPanel (Client Component)
 *
 * Matches `TEAM_INTEGRATION.md` Section 3 (`ProductPanelProps`) for 1-line plug-in
 * into Tilak's right-hand inspector:
 * ```tsx
 * <ProductPanel
 *   selectedObject={selectedObject}
 *   scene={scene}
 *   onReplaceObjectProduct={(objectId, product, verifiedSize) => {
 *     useSceneStore.getState().updateObject(objectId, {
 *       source: 'shopify',
 *       product,
 *       dimensionsVerified: Boolean(verifiedSize),
 *       ...(verifiedSize ? { size: verifiedSize } : {}),
 *     });
 *   }}
 * />
 * ```
 *
 * Displays ONLY real products from `GET /api/products`, allows variant selection,
 * replaces the selected 3D scene object via `onReplaceObjectProduct`, separates
 * owned fixtures ($0) from new Shopify purchases, and creates merchant-specific
 * buyer-controlled carts via `POST /api/cart`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProductRef,
  SceneObject,
  SceneObjectKind,
  ShopScene,
  Vec3,
} from "@/lib/schema";
import { useSceneStore } from "@/store/useSceneStore";

export interface CartHandoffEntry {
  seller: string;
  sellerDomain?: string;
  cartUrl: string | null;
  checkoutUrl?: string | null;
  subtotalCents?: number;
  totalCents?: number;
  currency?: string;
  fallbackProductUrls?: Array<{
    variantId: string;
    quantity: number;
    productUrl: string | null;
  }>;
}

export interface CartHandoffResult {
  carts: CartHandoffEntry[];
  warnings: string[];
}

export interface ProductPanelProps {
  /** Currently selected object in the 3D scene. */
  selectedObject: SceneObject | null;
  /** Current validated ShopScene (used for budget, owned vs new totals, and cart items). */
  scene: ShopScene;
  /** Called when the user clicks "Replace in 3D scene" with the chosen real variant. */
  onReplaceObjectProduct: (
    objectId: string,
    product: ProductRef,
    verifiedSize?: Vec3
  ) => void;
  /** Called when the user clicks "Add" to insert the chosen real variant as a new 3D object. */
  onAddObjectProduct?: (product: ProductRef, verifiedSize?: Vec3) => void;
  /** Optional controlled products list; if omitted, ProductPanel fetches live from /api/products. */
  products?: ProductRef[];
  /** Optional controlled loading state (used when `products` is passed externally). */
  loading?: boolean;
  /** Optional controlled error state (used when `products` is passed externally). */
  error?: string | null;
  /** Optional callback invoked alongside built-in /api/cart handoff when clicking "Review cart". */
  onReviewCart?: () => void;
  /** Optional retry callback when controlled externally. */
  onRetry?: () => void;
  /** Optional externally supplied /api/cart result. */
  cartResult?: CartHandoffResult | null;
  /** Render full panel ('all'), browse-only ('shop'), or cart-only ('cart'). */
  view?: "all" | "shop" | "cart";
}

const KIND_TO_DEFAULT_QUERY: Record<SceneObjectKind, string> = {
  shelf: "display shelf",
  counter: "retail checkout counter",
  table: "display table",
  rack: "clothing rack",
  lamp: "floor lamp",
  plant: "planter",
  art: "framed wall art",
};

const QUICK_CATEGORIES = [
  "display shelf",
  "display table",
  "clothing rack",
  "floor lamp",
  "planter",
] as const;

function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

interface ProductGroup {
  productId: string;
  variants: ProductRef[];
}

export function ProductPanel({
  selectedObject,
  scene,
  onReplaceObjectProduct,
  onAddObjectProduct,
  products: controlledProducts,
  loading: controlledLoading,
  error: controlledError,
  onReviewCart,
  onRetry,
  cartResult: controlledCartResult,
  view = "all",
}: ProductPanelProps) {
  const isControlledProducts = controlledProducts !== undefined;

  const voiceShopQuery = useSceneStore((s) => s.voiceShopQuery);
  const voiceShopProducts = useSceneStore((s) => s.voiceShopProducts);
  const voiceOrderResult = useSceneStore((s) => s.voiceOrderResult);
  const voiceOrderItems = useSceneStore((s) => s.voiceOrderItems);
  const orderConfirmation = useSceneStore((s) => s.orderConfirmation);
  const setOrderConfirmation = useSceneStore((s) => s.setOrderConfirmation);
  const cartObjectIds = useSceneStore((s) => s.cartObjectIds);
  const removeFromCart = useSceneStore((s) => s.removeFromCart);
  const removeVoiceOrderItem = useSceneStore((s) => s.removeVoiceOrderItem);
  const setVoiceOrderResult = useSceneStore((s) => s.setVoiceOrderResult);

  const [customQuery, setCustomQuery] = useState<string | null>(null);
  const [fetchedProducts, setFetchedProducts] = useState<ProductRef[]>([]);
  const [fetchedWarnings, setFetchedWarnings] = useState<string[]>([]);
  const [internalLoading, setInternalLoading] = useState<boolean>(false);
  const [internalError, setInternalError] = useState<string | null>(null);

  const selectedKind = selectedObject?.kind;
  const query =
    customQuery ??
    voiceShopQuery ??
    (selectedKind ? KIND_TO_DEFAULT_QUERY[selectedKind] : "");

  const [selectedVariantByProduct, setSelectedVariantByProduct] = useState<Record<string, string>>(
    {}
  );
  const [loadedVariantsByProduct, setLoadedVariantsByProduct] = useState<
    Record<string, ProductRef[]>
  >({});
  const [loadingVariantsFor, setLoadingVariantsFor] = useState<string | null>(null);
  const [variantErrorByProduct, setVariantErrorByProduct] = useState<Record<string, string>>({});
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  const [creatingCart, setCreatingCart] = useState<boolean>(false);
  const [cartError, setCartError] = useState<string | null>(null);
  const [internalCartResult, setInternalCartResult] = useState<CartHandoffResult | null>(null);

  const fetchLiveProducts = useCallback(async (searchQuery: string, maxPriceCents?: number) => {
    setInternalLoading(true);
    setInternalError(null);
    setFetchedWarnings([]);

    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      if (typeof maxPriceCents === "number" && maxPriceCents > 0) {
        params.set("maxPrice", String(Math.floor(maxPriceCents)));
      }

      const url = `/api/products${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const msg =
          (data &&
            typeof data === "object" &&
            (data as { error?: { message?: string } }).error?.message) ||
          `Product search failed with HTTP ${res.status}.`;
        throw new Error(msg);
      }

      const list = Array.isArray((data as { products?: unknown }).products)
        ? ((data as { products: ProductRef[] }).products)
        : [];
      const warnings = Array.isArray((data as { warnings?: unknown }).warnings)
        ? ((data as { warnings: string[] }).warnings)
        : [];

      setFetchedProducts(list);
      setFetchedWarnings(warnings);
    } catch (err) {
      setInternalError(
        err instanceof Error ? err.message : "Unable to load live Shopify products."
      );
    } finally {
      setInternalLoading(false);
    }
  }, []);

  // Auto-query when selectedObject kind changes (in uncontrolled mode)
  useEffect(() => {
    if (isControlledProducts) return;
    let cancelled = false;
    const nextQuery = selectedKind ? KIND_TO_DEFAULT_QUERY[selectedKind] : "";
    const maxPriceCents = scene.budgetCents > 0 ? scene.budgetCents : undefined;

    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (typeof maxPriceCents === "number" && maxPriceCents > 0) {
      params.set("maxPrice", String(Math.floor(maxPriceCents)));
    }
    const url = `/api/products${params.toString() ? `?${params.toString()}` : ""}`;

    fetch(url)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const msg =
            (data &&
              typeof data === "object" &&
              (data as { error?: { message?: string } }).error?.message) ||
            `Product search failed with HTTP ${res.status}.`;
          throw new Error(msg);
        }
        return data as { products?: ProductRef[]; warnings?: string[] };
      })
      .then((data) => {
        if (cancelled) return;
        setFetchedProducts(Array.isArray(data.products) ? data.products : []);
        setFetchedWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setInternalError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setInternalError(
          err instanceof Error ? err.message : "Unable to load live Shopify products."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [isControlledProducts, scene.budgetCents, selectedKind]);

  const activeProducts =
    controlledProducts ??
    (customQuery === null && voiceShopProducts.length > 0
      ? voiceShopProducts
      : fetchedProducts);
  const isLoading = controlledLoading ?? internalLoading;
  const activeError = controlledError !== undefined ? controlledError : internalError;
  const activeCartResult =
    controlledCartResult ?? internalCartResult ?? voiceOrderResult;

  const groupedProducts = useMemo<ProductGroup[]>(() => {
    const map = new Map<string, ProductRef[]>();
    for (const p of activeProducts) {
      const existing = map.get(p.productId);
      if (existing) {
        if (!existing.some((v) => v.variantId === p.variantId)) {
          existing.push(p);
        }
      } else {
        map.set(p.productId, [p]);
      }
    }

    return Array.from(map.entries()).map(([productId, baseVariants]) => {
      const extra = loadedVariantsByProduct[productId] ?? [];
      const merged = [...baseVariants];
      for (const v of extra) {
        if (!merged.some((m) => m.variantId === v.variantId)) {
          merged.push(v);
        }
      }
      return { productId, variants: merged };
    });
  }, [activeProducts, loadedVariantsByProduct]);

  // Separate owned fixtures ($0) from carted Shopify purchases (scene cartObjectIds + direct voice orders).
  const { ownedCount, shopifyObjects, extraVoiceProducts, newPurchaseTotalCents, totalCurrency } = useMemo(() => {
    let owned = 0;
    const cartItems: SceneObject[] = [];
    const cartIdSet = new Set(cartObjectIds);
    const seenVariantIds = new Set<string>();
    let totalCents = 0;
    let currency = "USD";

    for (const obj of scene.objects) {
      if (obj.source === "owned") {
        owned += 1;
        continue;
      }
      if (cartIdSet.has(obj.id)) {
        cartItems.push(obj);
        if (obj.product) {
          seenVariantIds.add(obj.product.variantId);
          totalCents += obj.product.priceCents;
          if (obj.product.currency) currency = obj.product.currency;
        }
      }
    }

    const extraVoice: ProductRef[] = [];
    for (const p of voiceOrderItems) {
      if (!seenVariantIds.has(p.variantId)) {
        seenVariantIds.add(p.variantId);
        extraVoice.push(p);
        totalCents += p.priceCents;
        if (p.currency) currency = p.currency;
      }
    }

    return {
      ownedCount: owned,
      shopifyObjects: cartItems,
      extraVoiceProducts: extraVoice,
      newPurchaseTotalCents: totalCents,
      totalCurrency: currency,
    };
  }, [scene.objects, cartObjectIds, voiceOrderItems]);

  const totalCartCount = shopifyObjects.length + extraVoiceProducts.length;

  const handleRemoveFromCart = (obj: SceneObject) => {
    removeFromCart(obj.id);
    if (obj.product) {
      removeVoiceOrderItem(obj.product.variantId);
    }
    setInternalCartResult(null);
    if (voiceOrderResult) {
      setVoiceOrderResult(null);
    }
  };

  const handleRemoveVoiceProduct = (variantId: string) => {
    removeVoiceOrderItem(variantId);
    setInternalCartResult(null);
  };

  const handleFetchVariants = async (productId: string) => {
    setLoadingVariantsFor(productId);
    setVariantErrorByProduct((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });

    try {
      const res = await fetch(`/api/products?productId=${encodeURIComponent(productId)}`);
      if (!res.ok) {
        setVariantErrorByProduct((prev) => ({
          ...prev,
          [productId]: "Additional options unavailable for this item.",
        }));
        return;
      }
      const data = (await res.json()) as { variants?: ProductRef[] };
      if (Array.isArray(data.variants) && data.variants.length > 1) {
        setLoadedVariantsByProduct((prev) => ({
          ...prev,
          [productId]: data.variants!,
        }));
      } else {
        setVariantErrorByProduct((prev) => ({
          ...prev,
          [productId]: "No additional options listed by merchant.",
        }));
      }
    } catch {
      setVariantErrorByProduct((prev) => ({
        ...prev,
        [productId]: "Additional options unavailable for this item.",
      }));
    } finally {
      setLoadingVariantsFor(null);
    }
  };

  const handleReviewCartClick = async () => {
    onReviewCart?.();
    if (controlledCartResult !== undefined || totalCartCount === 0) return;

    setCreatingCart(true);
    setCartError(null);

    try {
      const lines = [
        ...shopifyObjects
          .filter((o): o is SceneObject & { product: ProductRef } => Boolean(o.product))
          .map((o) => ({
            variantId: o.product.variantId,
            seller: o.product.seller,
            sellerDomain: o.product.sellerDomain,
            productUrl: o.product.productUrl,
            quantity: 1,
          })),
        ...extraVoiceProducts.map((p) => ({
          variantId: p.variantId,
          seller: p.seller,
          sellerDomain: p.sellerDomain,
          productUrl: p.productUrl,
          quantity: 1,
        })),
      ];

      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (data &&
            typeof data === "object" &&
            (data as { error?: { message?: string } }).error?.message) ||
          `Cart creation failed with HTTP ${res.status}.`;
        throw new Error(msg);
      }

      setInternalCartResult(data as CartHandoffResult);
    } catch (err) {
      setCartError(
        err instanceof Error ? err.message : "Unable to build merchant cart links right now."
      );
    } finally {
      setCreatingCart(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isControlledProducts) return;
    void fetchLiveProducts(query, scene.budgetCents > 0 ? scene.budgetCents : undefined);
  };

  const handleRetry = () => {
    if (onRetry) {
      onRetry();
    } else {
      void fetchLiveProducts(query, scene.budgetCents > 0 ? scene.budgetCents : undefined);
    }
  };

  return (
    <aside
      aria-label={view === "cart" ? "Shopify Shopping Cart" : "Shopify Product Panel"}
      className="flex h-full w-full flex-col rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-lg"
    >
      {view !== "cart" && (
        <>
          {/* Header + Search */}
          <div className="space-y-3 border-b border-zinc-800 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">Real Shopify Products</h2>
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
            {groupedProducts.length} live
          </span>
        </div>

        <p className="text-xs text-zinc-400">
          {selectedObject
            ? `Replacing: ${selectedObject.label} (${selectedObject.kind})`
            : "Select a fixture in the 3D scene to replace it with a real Shopify product."}
        </p>

        {!isControlledProducts && (
          <div className="space-y-2">
            <form onSubmit={handleSearchSubmit} className="flex gap-1.5">
              <label htmlFor="shopify-product-search" className="sr-only">
                Search Shopify catalog
              </label>
              <input
                id="shopify-product-search"
                type="search"
                value={query}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="Search shelves, racks, lamps..."
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-amber-300 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
              >
                Search
              </button>
            </form>

            <div className="flex flex-wrap gap-1">
              {QUICK_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setCustomQuery(cat);
                    void fetchLiveProducts(cat, scene.budgetCents > 0 ? scene.budgetCents : undefined);
                  }}
                  className={`rounded-full border px-2 py-0.5 text-[11px] capitalize transition ${
                    query.toLowerCase() === cat
                      ? "border-amber-300/60 bg-amber-300/15 text-amber-200"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Body: Loading / Error / Empty / Live Products */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {isLoading && (
          <div role="status" aria-live="polite" className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-28 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900"
              />
            ))}
          </div>
        )}

        {!isLoading && activeError && (
          <div
            role="alert"
            className="rounded-xl border border-red-500/40 bg-red-950/50 p-4 text-xs text-red-200"
          >
            <p className="font-medium">Unable to load Shopify products</p>
            <p className="mt-1 opacity-90">{activeError}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
            >
              Retry search
            </button>
          </div>
        )}

        {!isLoading && !activeError && fetchedWarnings.length > 0 && (
          <div
            role="status"
            className="rounded-xl border border-amber-400/30 bg-amber-950/30 p-3 text-xs text-amber-200"
          >
            {fetchedWarnings.map((w, idx) => (
              <p key={idx}>{w}</p>
            ))}
          </div>
        )}

        {!isLoading && !activeError && groupedProducts.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-xs text-zinc-400">
            No matching live Shopify products found. Try broadening your search or raising your budget.
          </div>
        )}

        {!isLoading &&
          !activeError &&
          groupedProducts.map(({ productId, variants }, groupIdx) => {
            const activeVariantId =
              selectedVariantByProduct[productId] ?? variants[0]?.variantId;
            const activeVariant =
              variants.find((v) => v.variantId === activeVariantId) ?? variants[0];

            if (!activeVariant) return null;

            const isAvailable = activeVariant.available !== false;
            const showImage =
              Boolean(activeVariant.imageUrl) && !brokenImages[activeVariant.variantId];

            return (
              <article
                key={productId}
                className="relative rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition hover:border-zinc-700"
              >
                <span className="absolute -top-2 -left-1.5 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 shadow">
                  #{groupIdx + 1}
                </span>
                <div className="flex gap-3">
                  <div className="h-18 w-18 flex-shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                    {showImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={activeVariant.imageUrl}
                        alt={activeVariant.title}
                        onError={() =>
                          setBrokenImages((prev) => ({
                            ...prev,
                            [activeVariant.variantId]: true,
                          }))
                        }
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-500">
                        No image
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 text-xs font-medium text-zinc-100">
                        {activeVariant.title}
                      </h3>
                      <span className="flex-shrink-0 text-xs font-semibold text-amber-200">
                        {formatMoney(activeVariant.priceCents, activeVariant.currency)}
                      </span>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>{activeVariant.seller}</span>
                      <span aria-hidden="true">&middot;</span>
                      <span
                        className={
                          isAvailable ? "font-medium text-emerald-400" : "font-medium text-red-400"
                        }
                      >
                        {isAvailable ? "In stock" : "Out of stock"}
                      </span>
                      <span aria-hidden="true">&middot;</span>
                      <span className="text-zinc-500">Dimensions not listed by merchant</span>
                    </div>

                    {activeVariant.productUrl && (
                      <a
                        href={activeVariant.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-[11px] text-zinc-400 underline hover:text-zinc-100"
                      >
                        View on {activeVariant.seller}
                      </a>
                    )}
                  </div>
                </div>

                {/* Variant picker + Replace action */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {variants.length > 1 ? (
                    <label className="flex flex-1 items-center gap-2 text-xs text-zinc-300">
                      <span className="sr-only">Choose variant for {activeVariant.title}</span>
                      <select
                        aria-label={`Variant for ${activeVariant.title}`}
                        value={activeVariant.variantId}
                        onChange={(e) =>
                          setSelectedVariantByProduct((prev) => ({
                            ...prev,
                            [productId]: e.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100"
                      >
                        {variants.map((v) => (
                          <option key={v.variantId} value={v.variantId}>
                            {v.title} &mdash; {formatMoney(v.priceCents, v.currency)}
                            {v.available === false ? " (Out of stock)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <button
                      type="button"
                      disabled={loadingVariantsFor === productId}
                      onClick={() => void handleFetchVariants(productId)}
                      className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {loadingVariantsFor === productId ? "Checking options..." : "Check options"}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!selectedObject || !isAvailable}
                    onClick={() => {
                      if (!selectedObject) return;
                      onReplaceObjectProduct(selectedObject.id, activeVariant);
                    }}
                    className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Replace in 3D scene
                  </button>

                  {onAddObjectProduct && (
                    <button
                      type="button"
                      disabled={!isAvailable}
                      onClick={() => onAddObjectProduct(activeVariant)}
                      title="Add this product as a new item in the 3D room"
                      className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      + Add
                    </button>
                  )}
                </div>

                {variantErrorByProduct[productId] && (
                  <p className="mt-1.5 text-[11px] text-zinc-400">
                    {variantErrorByProduct[productId]}
                  </p>
                )}
              </article>
            );
          })}
      </div>
        </>
      )}

      {/* Footer / Dedicated Cart View: Owned ($0) vs Carted Shopify Purchases + Merchant Cart Handoff */}
      {view !== "shop" && (
      <div
        className={`bg-zinc-900/70 p-4 ${
          view === "cart"
            ? "flex min-h-0 flex-1 flex-col overflow-y-auto"
            : "border-t border-zinc-800"
        }`}
      >
        {view === "cart" && (
          <div className="mb-3 flex items-center justify-between border-b border-zinc-800 pb-2.5">
            <h2 className="text-sm font-semibold text-zinc-100">Your Shopping Cart</h2>
            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200">
              {totalCartCount} {totalCartCount === 1 ? "item" : "items"}
            </span>
          </div>
        )}

        {orderConfirmation && (
          <div
            role="status"
            className="mb-3 space-y-2 rounded-xl border border-emerald-400/45 bg-emerald-950/45 p-3 text-xs text-emerald-100 shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 font-semibold text-emerald-200">
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400 text-[10px] font-bold text-zinc-950">
                    ✓
                  </span>
                  <span>Order Confirmed</span>
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-emerald-300/90">
                  #{orderConfirmation.orderId} · {orderConfirmation.placedAt}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrderConfirmation(null)}
                className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-emerald-200/80 hover:bg-emerald-500/20 hover:text-white"
              >
                Dismiss
              </button>
            </div>
            <ul className="space-y-1 border-t border-emerald-400/20 pt-2 text-[11px]">
              {orderConfirmation.items.map((item, idx) => (
                <li key={idx} className="flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-100">{item.title}</span>
                  <span className="shrink-0 font-semibold text-amber-200">
                    {formatMoney(item.priceCents, item.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-emerald-400/20 pt-1.5 font-semibold">
              <span>Order Total</span>
              <span className="text-amber-200">
                {formatMoney(orderConfirmation.totalCents, orderConfirmation.currency)}
              </span>
            </div>
            {orderConfirmation.checkoutUrl && (
              <a
                href={orderConfirmation.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex w-full items-center justify-center rounded-lg bg-emerald-400 px-3 py-1.5 font-semibold text-zinc-950 hover:bg-emerald-300"
              >
                View Shopify Merchant Receipt / Checkout &rarr;
              </a>
            )}
          </div>
        )}
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between text-zinc-400">
            <span>Owned items ({ownedCount})</span>
            <span className="font-medium text-zinc-300">{formatMoney(0, totalCurrency)}</span>
          </div>
          <div className="flex items-center justify-between text-sm font-semibold text-zinc-100">
            <span>Cart items ({totalCartCount})</span>
            <span className="text-amber-200">
              {formatMoney(newPurchaseTotalCents, totalCurrency)}
            </span>
          </div>
        </div>

        {totalCartCount > 0 && (
          <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-0.5">
            {shopifyObjects.map((obj) => (
              <li
                key={obj.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/75 px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-zinc-200">
                  {obj.product?.title ?? obj.label}
                </span>
                <span className="shrink-0 font-medium text-amber-200">
                  {obj.product
                    ? formatMoney(obj.product.priceCents, obj.product.currency)
                    : "Sourcing…"}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveFromCart(obj)}
                  title="Delete item from cart"
                  aria-label={`Delete ${obj.product?.title ?? obj.label} from cart`}
                  className="shrink-0 cursor-pointer rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/30 hover:text-red-100"
                >
                  Delete
                </button>
              </li>
            ))}
            {extraVoiceProducts.map((p) => (
              <li
                key={p.variantId}
                className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/75 px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-zinc-200">
                  {p.title}
                </span>
                <span className="shrink-0 font-medium text-amber-200">
                  {formatMoney(p.priceCents, p.currency)}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveVoiceProduct(p.variantId)}
                  title="Delete item from cart"
                  aria-label={`Delete ${p.title} from cart`}
                  className="shrink-0 cursor-pointer rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/30 hover:text-red-100"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {totalCartCount === 0 && (
          <p className="mt-2 text-[11px] text-zinc-400">
            Cart is empty. Add, replace, or lock a Shopify item to add it to your cart.
          </p>
        )}

        <button
          type="button"
          disabled={creatingCart || totalCartCount === 0}
          onClick={() => void handleReviewCartClick()}
          className="mt-3 w-full rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {creatingCart ? "Building merchant cart(s)..." : "Review cart"}
        </button>

        {cartError && (
          <p
            role="alert"
            className="mt-2 rounded-lg border border-red-500/40 bg-red-950/50 p-2 text-xs text-red-200"
          >
            {cartError}
          </p>
        )}

        {activeCartResult && (
          <div className="mt-3 space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs">
            {activeCartResult.warnings.length > 0 && (
              <ul
                role="alert"
                className="space-y-1 rounded-lg border border-amber-400/30 bg-amber-950/40 p-2 text-amber-200"
              >
                {activeCartResult.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            )}

            {activeCartResult.carts.map((cart, idx) => (
              <div
                key={`${cart.seller}-${idx}`}
                className="flex flex-col gap-1.5 border-t border-zinc-800 pt-2 first:border-t-0 first:pt-0"
              >
                <span className="font-medium text-zinc-100">{cart.seller}</span>
                {cart.cartUrl ? (
                  <a
                    href={cart.cartUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-lg bg-amber-300 px-3 py-1.5 font-semibold text-zinc-950 hover:bg-amber-200"
                  >
                    Open {cart.seller} cart &rarr;
                  </a>
                ) : (
                  <div className="space-y-1">
                    <p className="text-amber-200">
                      Cart creation unavailable for {cart.seller}. Review item(s) directly:
                    </p>
                    {cart.fallbackProductUrls?.map((item) =>
                      item.productUrl ? (
                        <a
                          key={item.variantId}
                          href={item.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-emerald-400 underline hover:text-emerald-300"
                        >
                          View product on {cart.seller} (qty {item.quantity}) &rarr;
                        </a>
                      ) : (
                        <span key={item.variantId} className="block text-zinc-500">
                          Product link unavailable for {item.variantId}
                        </span>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </aside>
  );
}

export default ProductPanel;
