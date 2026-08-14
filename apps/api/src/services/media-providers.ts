import type { Env } from '../env.js';
import { createAtlasProviders } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import {
  createRunPodImageOnlyProviders,
  createUnavailableVideoProvider,
} from '../media-pipeline/runpod-adapter.js';
import type { MediaProviders } from '../media-pipeline/types.js';

/**
 * Media provider selection (US-36 + US-87).
 *
 * - Mock when nothing live.
 * - RunPod live + preferForImages → ComfyUI images; Atlas video if Atlas live.
 * - Else Atlas live → Atlas image+video.
 */
export function selectMediaProviders(env: Env): MediaProviders {
  const mock = () =>
    createMockProviders({
      imageFixturePath:
        process.env.MEDIA_MOCK_IMAGE_FIXTURE ?? 'apps/web/public/media/luna/profile-04.jpg',
      videoFixturePath:
        process.env.MEDIA_MOCK_VIDEO_FIXTURE ?? 'apps/web/public/media/luna/profile-04.mp4',
    });

  const atlasLive = env.media.atlas.live;
  const runpodLive = env.media.runpod.live;
  const runpodImages = runpodLive && env.media.runpod.preferForImages;

  if (!atlasLive && !runpodLive) {
    return mock();
  }

  const atlas = atlasLive
    ? createAtlasProviders({
        baseUrl: env.media.atlas.baseUrl,
        imageModel: env.media.atlas.imageModel,
        videoModel: env.media.atlas.videoModel,
        contractConfirmed: true,
      })
    : null;

  if (runpodImages) {
    const endpointId = env.media.runpod.endpointId;
    if (!endpointId) {
      throw new Error('RUNPOD_ENDPOINT_ID missing despite runpod.live');
    }
    let workflow: Record<string, unknown> | undefined;
    if (process.env.RUNPOD_WORKFLOW_JSON) {
      try {
        workflow = JSON.parse(process.env.RUNPOD_WORKFLOW_JSON) as Record<string, unknown>;
      } catch {
        throw new Error('RUNPOD_WORKFLOW_JSON is set but is not valid JSON');
      }
    }
    const video =
      atlas?.video ??
      createUnavailableVideoProvider(
        'Video requires Atlas live (MEDIA_LIVE_CONFIRM=true + ATLASCLOUD_API_KEY). RunPod is image-only in US-87.',
      );
    return createRunPodImageOnlyProviders(
      {
        endpointId,
        workflow,
        promptNodeId: process.env.RUNPOD_PROMPT_NODE_ID ?? '6',
        contractConfirmed: true,
      },
      video,
    );
  }

  if (atlas) return atlas;
  return mock();
}
