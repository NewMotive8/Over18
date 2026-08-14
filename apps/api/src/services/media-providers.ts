import type { Env } from '../env.js';
import { createAtlasProviders } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import {
  createRunPodImageOnlyProviders,
  createUnavailableVideoProvider,
} from '../media-pipeline/runpod-adapter.js';
import { createRunPodPublicVideoProvider } from '../media-pipeline/runpod-video-public.js';
import type { MediaProviders, VideoProvider } from '../media-pipeline/types.js';

function envFlagTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

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

  // Public Wan I2V. Wan 2.7 Spicy is not on RunPod — use wan-2-1-i2v-720 or wan-2-6-i2v.
  const videoEndpoint =
    (process.env.RUNPOD_VIDEO_ENDPOINT_ID ?? '').trim() || 'wan-2-1-i2v-720';
  const wantRunpodVideo =
    envFlagTrue('MEDIA_RUNPOD_VIDEO') ||
    (envFlagTrue('MEDIA_RUNPOD_CONFIRM') && Boolean((process.env.RUNPOD_API_KEY ?? '').trim()));

  let runpodVideo: VideoProvider | null = null;
  if (wantRunpodVideo && envFlagTrue('MEDIA_RUNPOD_CONFIRM') && (process.env.RUNPOD_API_KEY ?? '').trim()) {
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
    // Prefer RunPod public I2V; do NOT fall back to broken Atlas video when user asked for RunPod.
    const video: VideoProvider =
      runpodVideo ??
      (envFlagTrue('MEDIA_RUNPOD_VIDEO')
        ? createUnavailableVideoProvider(
            'MEDIA_RUNPOD_VIDEO=true but RUNPOD_API_KEY / MEDIA_RUNPOD_CONFIRM missing — refusing Atlas video fallback.',
          )
        : (atlas?.video ??
          createUnavailableVideoProvider(
            'Video requires MEDIA_RUNPOD_VIDEO=true + RUNPOD_API_KEY or Atlas live.',
          )));
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
