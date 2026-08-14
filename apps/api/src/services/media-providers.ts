import type { Env } from '../env.js';
import { createAtlasProviders } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import {
  createRunPodImageOnlyProviders,
  createUnavailableVideoProvider,
} from '../media-pipeline/runpod-adapter.js';
import { createRunPodPublicVideoProvider } from '../media-pipeline/runpod-video-public.js';
import type { MediaProviders, VideoProvider } from '../media-pipeline/types.js';

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

  // Public Wan I2V (default wan-2-1-i2v-720). Wan 2.7 Spicy is not on RunPod.
  const videoEndpoint =
    (process.env.RUNPOD_VIDEO_ENDPOINT_ID ?? '').trim() || 'wan-2-1-i2v-720';
  const runpodVideoEnabled =
    envFlagTrue('MEDIA_RUNPOD_CONFIRM') &&
    Boolean((process.env.RUNPOD_API_KEY ?? '').trim()) &&
    envFlagTrue('MEDIA_RUNPOD_VIDEO');

  let runpodVideo: VideoProvider | null = null;
  if (runpodVideoEnabled) {
    runpodVideo = createRunPodPublicVideoProvider({
      endpointId: videoEndpoint,
      contractConfirmed: true,
    });
  }

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
      runpodVideo ??
      atlas?.video ??
      createUnavailableVideoProvider(
        'Video requires MEDIA_RUNPOD_VIDEO=true (RunPod public Wan I2V) or Atlas live.',
      );
    const baseUrl = (process.env.RUNPOD_BASE_URL ?? 'https://api.runpod.ai/v2').replace(/\/+$/, '');
    return createRunPodImageOnlyProviders(
      {
        endpointId,
        baseUrl,
        workflow,
        promptNodeId: process.env.RUNPOD_PROMPT_NODE_ID ?? '6',
        contractConfirmed: true,
      },
      video,
    );
  }

  if (atlas) {
    if (runpodVideo) {
      return { image: atlas.image, video: runpodVideo };
    }
    return atlas;
  }
  return mock();
}

function envFlagTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}
