import { NextRequest, NextResponse } from "next/server";
import {
  getProduct,
  searchDefaultCatalog,
  searchProducts,
  ShopMcpError,
} from "@/lib/shopify";

function parseMaxPriceCents(raw: string | null): { value?: number; error?: string } {
  if (raw === null || raw.trim() === "") {
    return {};
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    return {
      error: "Query parameter 'maxPrice' must be a non-negative integer (price in cents).",
    };
  }
  return { value: parsed };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const productId = searchParams.get("productId")?.trim() ?? "";
  const maxPriceParam = searchParams.get("maxPrice");

  const { value: maxPriceCents, error: maxPriceError } = parseMaxPriceCents(maxPriceParam);
  if (maxPriceError) {
    return NextResponse.json(
      { error: { code: "INVALID_MAX_PRICE", message: maxPriceError } },
      { status: 400 }
    );
  }

  try {
    if (productId) {
      const details = await getProduct(productId);
      return NextResponse.json({
        product: details.product,
        variants: details.variants,
        options: details.options,
        products: details.variants,
      });
    }

    const products = q
      ? await searchProducts(q, maxPriceCents)
      : await searchDefaultCatalog(maxPriceCents);

    const warnings: string[] = [];
    if (products.length === 0 && typeof maxPriceCents === "number") {
      warnings.push(
        `No matching Shopify products were found under $${(maxPriceCents / 100).toFixed(2)}. Try raising your budget or broadening your search.`
      );
    }

    return NextResponse.json(warnings.length > 0 ? { products, warnings } : { products });
  } catch (err) {
    if (err instanceof ShopMcpError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
          },
        },
        { status: err.status }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Unexpected error while querying Shopify Shop MCP.",
        },
      },
      { status: 500 }
    );
  }
}
