import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  GeminiServiceError,
  PLAN_MODEL_ID,
  replaceObjectInScene,
  ReplaceRequestSchema,
} from '@/lib/gemini';

export const maxDuration = 60;

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

  const parsed = ReplaceRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid /api/replace payload: ${detail}`,
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  try {
    const result = await replaceObjectInScene(parsed.data, { requestId });
    return NextResponse.json(
      {
        scene: result.scene,
        action: result.action,
        targetObjectId: result.targetObjectId,
        replacedObject: result.replacedObject,
        issues: result.issues,
        valid: result.valid,
        explanation: result.explanation,
        modelUsed: result.modelUsed,
        requestId: result.requestId,
      },
      { status: 200, headers: { 'x-request-id': requestId } }
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
        { status: err.status, headers: { 'x-request-id': requestId } }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error while replacing 3D object.',
          requestId,
          modelAttempted: PLAN_MODEL_ID,
        },
      },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
