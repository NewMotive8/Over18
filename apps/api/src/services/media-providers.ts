import type { Env } from '../env.js';
import { createAtlasProviders } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import type { MediaProviders } from '../media-pipeline/types.js';

/**
 * Media provider selection (US-36) — the app-side mirror of the LLM reply-
 * provider seam. The vendor (Atlas) stays entirely behind the adapter; this
 * function only decides WHICH implementation the media-generation service runs
 * against, based on configuration:
 *
 *   env.media.atlas.live === true  → the real Atlas adapter, with the paid-call
 *                                    contract gate confirmed (live === true is
 *                                    reached only when a key is present AND
 *                                    MEDIA_LIVE_CONFIRM=true).
 *   otherwise                      → the deterministic, zero-spend mock adapter,
 *                                    which "generates" by copying local fixture
 *                                    media so the whole store-to-DB path is
 *                                    exercised without touching a paid API.
 *
 * Tests inject their own providers directly into buildApp/the service and never
 * go through this function, so the mock fixtures here only matter for a local
 * dev server run without live credentials.
 */
export function selectMediaProviders(env: Env): MediaProviders {
  if (env.media.atlas.live) {
    return createAtlasProviders({
      baseUrl: env.media.atlas.baseUrl,
      imageModel: env.media.atlas.imageModel,
      videoModel: env.media.atlas.videoModel,
      // Reaching this branch already required MEDIA_LIVE_CONFIRM=true.
      contractConfirmed: true,
    });
  }
  return createMockProviders({
    imageFixturePath:
      process.env.MEDIA_MOCK_IMAGE_FIXTURE ?? 'apps/web/public/media/luna/profile-04.jpg',
    videoFixturePath:
      process.env.MEDIA_MOCK_VIDEO_FIXTURE ?? 'apps/web/public/media/luna/profile-04.mp4',
  });
}
