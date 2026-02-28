/**
 * cardUtils.ts
 *
 * Utilities for resolving card display names and image URLs.
 *
 * Card images are hosted on the Karabast S3 bucket at:
 *   https://karabast-data.s3.amazonaws.com/cards/{SET}/standard/large/{NNN}.webp?v=2
 *
 * The setId shape ({ set: string, number: number }) comes directly off
 * CardSummary objects in the game state.
 */

export interface SetId {
  set: string;
  number: number;
}

const S3_BASE = 'https://karabast-data.s3.amazonaws.com';

export function cardImageUrl(setId: SetId | undefined | null): string | null {
  if (!setId || !setId.set || !setId.number) return null;
  const num = String(setId.number).padStart(3, '0');
  return `${S3_BASE}/cards/${setId.set}/standard/large/${num}.webp?v=2`;
}

export function leaderDeployedImageUrl(setId: SetId | undefined | null): string | null {
  if (!setId || !setId.set || !setId.number) return null;
  const num = String(setId.number).padStart(3, '0');
  return `${S3_BASE}/cards/${setId.set}/standard/large/${num}-base.webp?v=2`;
}

export const CARD_BACK_URL = `${S3_BASE}/game/swu-cardback.webp`;
