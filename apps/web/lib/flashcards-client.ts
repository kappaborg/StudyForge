'use client';

import { apiPost } from './dev-fetch';

export interface ManualFlashcardResult {
  flashcardId: string;
  deckId: string;
}

export async function saveManualFlashcard(input: {
  front: string;
  back: string;
  folderId?: string | null;
}): Promise<ManualFlashcardResult> {
  return apiPost<ManualFlashcardResult>('/v1/flashcards/manual', {
    front: input.front,
    back: input.back,
    ...(input.folderId ? { folderId: input.folderId } : {}),
  });
}
