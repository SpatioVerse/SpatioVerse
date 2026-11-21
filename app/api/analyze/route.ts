import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  ANALYZE_MODEL_ID,
  analyzeSpaceMedia,
  GeminiServiceError,
} from '../../../lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 60;

function extractUploadedFile(formData: FormData): File | null {
  const preferredKeys = ['file', 'media', 'video', 'image'];
  for (const key of preferredKeys) {
    const entry = formData.get(key);
    if (entry instanceof File) {
      return entry;
    }
  }
  for (const [, entry] of formData.entries()) {
    if (entry instanceof File) {
      return entry;
    }
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message:
            'Expected multipart/form-data request containing an uploaded JPG, PNG, WebP, MP4, or WebM file.',
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'FAILED_UPLOAD_PARSE',
          message: 'Could not parse multipart/form-data upload payload.',
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  const uploadedFile = extractUploadedFile(formData);
  if (!uploadedFile) {
    return NextResponse.json(
      {
        error: {
          code: 'MISSING_FILE',
          message:
            'No media file found in form-data. Provide a file under field "file" (or "media").',
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  const rawNotes = formData.get('notes');
  const notes = typeof rawNotes === 'string' ? rawNotes : undefined;

  try {
    const arrayBuffer = await uploadedFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await analyzeSpaceMedia({
      buffer,
      mimeType: uploadedFile.type,
      fileName: uploadedFile.name,
      notes,
      requestId,
    });

    return NextResponse.json(
      {
        observations: result.observations,
        roomCues: result.roomCues,
        warnings: result.warnings,
        modelUsed: result.modelUsed,
        requestId: result.requestId,
        uploadMethod: result.uploadMethod,
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
            modelAttempted: err.modelAttempted ?? ANALYZE_MODEL_ID,
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
          message: 'Unexpected server error while analyzing uploaded media.',
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        },
      },
      {
        status: 500,
        headers: { 'x-request-id': requestId },
      }
    );
  }
}
