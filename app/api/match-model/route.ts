import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  GeminiServiceError,
  matchProductImageToGlb,
  MatchProductModelRequestSchema,
  PLAN_MODEL_ID,
} from '@/lib/gemini';

export const maxDuration = 30;

export async function POST(request: Request): Promise<NextResponse> {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  const parsed = MatchProductModelRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: 'Provide a product title and optional HTTPS imageUrl.',
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  try {
    const match = await matchProductImageToGlb(parsed.data, { requestId });
    return NextResponse.json(match, {
      status: 200,
      headers: { 'x-request-id': requestId },
    });
  } catch (err) {
    if (err instanceof GeminiServiceError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            requestId: err.requestId,
            modelAttempted: err.modelAttempted ?? PLAN_MODEL_ID,
          },
        },
        { status: err.status, headers: { 'x-request-id': requestId } }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to visually match product photo to 3D asset.',
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
