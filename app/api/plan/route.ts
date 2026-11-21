import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  GeminiServiceError,
  generateShopPlan,
  PLAN_MODEL_ID,
  PlanRequestSchema,
} from '../../../lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 90;

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

  const parsed = PlanRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid /api/plan request payload: ${detail}`,
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  try {
    const result = await generateShopPlan(parsed.data, { requestId });

    return NextResponse.json(
      {
        scene: result.scene,
        issues: result.issues,
        valid: result.valid,
        modelUsed: result.modelUsed,
        repairCount: result.repairCount,
        requestId: result.requestId,
      },
      {
        status: 200,
        headers: { 'x-request-id': requestId },
      }
    );
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
        {
          status: err.status,
          headers: { 'x-request-id': requestId },
        }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error while planning shop layout.',
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      {
        status: 500,
        headers: { 'x-request-id': requestId },
      }
    );
  }
}
