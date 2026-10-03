import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import { API_URL, ApiRequestError, charactersApi, conversationsApi, type PublicClip } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import {
  absoluteMediaUrl,
  apparentAge,
  characterHeaderItems,
  type CharacterMediaItem,
} from '../lib/media';
import { adultAgeFromBand } from '../lib/lobbyContent';
import { mockRelationship } from '../lib/relationship';
import ProfileHero from '../components/profile/ProfileHero';
import ProfileActions from '../components/profile/ProfileActions';
import RelationshipTracker from '../components/profile/RelationshipTracker';
import ProfileTabs, { type ProfileTab } from '../components/profile/ProfileTabs';
import AboutTab from '../components/profile/AboutTab';
import PostsTab from '../components/profile/PostsTab';
import MediaViewer from '../components/MediaViewer';
import PremiumFunnel from '../components/premium/PremiumFunnel';
import { commercialTier, useCustomerEconomy, type CustomerEconomyState } from '../lib/customerEconomy';
import CreditsPill from '../components/CreditsPill';

type VisualState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: CharacterVisualIdentityResponse };

type ProfileState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; character: PublicCharacter };

/**
 * Persona Profile — UI v2 (US-29).
 *
 * A media-led adult-companion profile: a paginated hero player over the
 * character's REAL video clips, a mock relationship tracker, primary actions
 * (Premium / Chat / Call), and About / Posts tabs — Posts carrying a content
 * paywall. Data loading (character + public Visual Identity), the Start-chat
 * flow, and the profile states are all preserved from the prior implementation;
 * only the presentation changed. Media flows through the existing provider-
 * agnostic resolver, the US-19 MediaViewer and the Premium funnel.
 */
export default function CharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { status: authStatus } = useAuth();
  const [state, setState] = useState<ProfileState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [visual, setVisual] = useState<VisualState>({ status: 'loading' });
  const [params, setParams] = useSearchParams();
  // `?tab=posts` opens on Posts -- the Credits Store sends a customer back here to finish an unlock.
  const [tab, setTab] = useState<ProfileTab>(() => (params.get('tab') === 'posts' ? 'posts' : 'about'));
  const resumeUnlock = params.get('unlock');
  const [viewer, setViewer] = useState<{ items: CharacterMediaItem[]; index: number } | null>(null);
  const [funnelOpen, setFunnelOpen] = useState(false);
  const [economy] = useCustomerEconomy();
  /**
   * Her real content collection, for the Posts tab.
   *
   * A separate request from the visual identity on purpose: identity is who she
   * is, this is what she has posted, and the tab must never substitute one for
   * the other. Failure degrades to an empty collection rather than to her
   * profile image — showing nothing is honest, showing her portrait is not.
   */
  const [clips, setClips] = useState<PublicClip[]>([]);

  const startChat = useCallback(
    async (character: PublicCharacter) => {
      if (authStatus !== 'authenticated') {
        navigate('/login', { state: { from: location.pathname } });
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const conversation = await conversationsApi.start(character.id);
        navigate(`/chat/${conversation.id}`);
      } catch {
        setStartError("Couldn't start the conversation. Please try again.");
        setStarting(false);
      }
    },
    [authStatus, navigate, location.pathname],
  );

  /**
   * The phone button. Opens the conversation and starts the call there.
   *
   * WHY IT NAVIGATES RATHER THAN CALLING FROM HERE. A call belongs to a
   * conversation -- that is where its transcript is stored and where the
   * memories it produces are read back -- and this page may not have one yet.
   * Routing through the chat page means one call implementation, one overlay and
   * one cleanup path, and the person ends up where the conversation they just
   * had actually lives.
   *
   * Shares `starting` with the Chat button, so pressing either twice, or both,
   * cannot open two conversations.
   */
  const startCall = useCallback(
    async (character: PublicCharacter) => {
      if (authStatus !== 'authenticated') {
        navigate('/login', { state: { from: location.pathname } });
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const conversation = await conversationsApi.start(character.id);
        navigate(`/chat/${conversation.id}`, { state: { autoCall: true } });
      } catch {
        setStartError("Couldn't start the call. Please try again.");
        setStarting(false);
      }
    },
    [authStatus, navigate, location.pathname],
  );

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    charactersApi
      .get(characterId)
      .then((character) => !cancelled && setState({ status: 'ready', character }))
      .catch((err) => {
        if (cancelled) return;
        setState(
          err instanceof ApiRequestError && err.status === 404
            ? { status: 'not-found' }
            : { status: 'error' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setVisual({ status: 'loading' });
    charactersApi
      .visualIdentity(characterId)
      .then((data) => !cancelled && setVisual({ status: 'ready', data }))
      .catch(() => !cancelled && setVisual({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setClips([]);
    charactersApi
      .clips(characterId)
      .then((res) => !cancelled && setClips(res.clips))
      .catch(() => !cancelled && setClips([]));
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const goBack = useCallback(() => navigate('/characters'), [navigate]);

  const backLink = (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex w-fit items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
    >
      <span aria-hidden>←</span> Back to lobby
    </button>
  );

  if (state.status === 'loading') {
    return (
      <section className="flex flex-col gap-4 px-4 pb-8 pt-6" aria-busy>
        {backLink}
        <div className="animate-pulse overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
          <div className="aspect-[4/5] w-full bg-zinc-800" />
        </div>
        <div className="h-12 animate-pulse rounded-2xl bg-zinc-900" />
      </section>
    );
  }

  if (state.status === 'not-found' || state.status === 'error') {
    const notFound = state.status === 'not-found';
    return (
      <section className="flex flex-col gap-4 px-4 pb-8 pt-6">
        {backLink}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            {notFound ? '☾' : '⚠'}
          </span>
          <div>
            <p className="font-medium">
              {notFound ? "This companion isn't available" : "Couldn't load this profile"}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              {notFound
                ? 'They may have been retired. Plenty of others would love to meet you.'
                : 'Check your connection and try again.'}
            </p>
          </div>
          {notFound ? (
            <Link
              to="/characters"
              className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Browse companions
            </Link>
          ) : (
            <button
              type="button"
              onClick={retry}
              className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  const { character } = state;
  const visualData = visual.status === 'ready' ? visual.data : null;
  const attributes = visualData?.identity?.attributes ?? [];
  /**
   * The header deck: her own videos.
   *
   * `clips` is the collection the Posts tab already fetches — reference-free
   * and approval-gated by the server. It used to be read only by that tab,
   * which is why the header showed a still for every CMS-created character
   * while her videos sat two tabs away. One function decides the whole deck;
   * see `characterHeaderItems` for the precedence and the fallback.
   */
  const heroItems: CharacterMediaItem[] = characterHeaderItems(character, clips, visualData);
  /**
   * The viewer items for the Posts tab — her posts, in the order shown.
   *
   * Previously the tab handed the viewer `heroItems`, so tapping the third post
   * opened whatever the hero deck had at index 2. Indexes now address the same
   * list the grid rendered.
   */
  const postItems: CharacterMediaItem[] = clips.map((clip) => ({
    id: clip.id,
    media:
      clip.mediaType === 'video'
        ? { kind: 'video', src: `${API_URL}${clip.url}` }
        : { kind: 'image', src: `${API_URL}${clip.url}` },
    premium: false,
  }));
  const age = adultAgeFromBand(apparentAge(visualData));
  const first = heroItems[0]!.media;
  const avatarPoster =
    first.kind === 'video'
      ? first.poster
      : first.kind === 'image'
        ? first.src
        : absoluteMediaUrl(character.profileImage);
  const relationship = mockRelationship(character);
  const upgrade = upgradeAction(economy, {
    openFunnel: () => setFunnelOpen(true),
    signIn: () => navigate('/login', { state: { from: location.pathname } }),
  });

  return (
    <div className="flex flex-col pb-10">
      <ProfileHero
        items={heroItems}
        name={character.displayName}
        age={age}
        avatarPoster={avatarPoster}
        onBack={goBack}
        onOpen={(index) => setViewer({ items: heroItems, index })}
        // The customer's Credits, one tap from the Credits Store. Nothing while unknown.
        topRight={<CreditsPill />}
      />

      <div className="flex flex-col gap-4 px-4 pt-4">
        {startError && (
          <p role="alert" className="rounded-lg border border-red-900 bg-red-950/90 px-3 py-2 text-center text-sm text-red-300">
            {startError}
          </p>
        )}

        <ProfileActions
          onUpgrade={upgrade ?? undefined}
          onChat={() => startChat(character)}
          onCall={() => startCall(character)}
          chatting={starting}
        />

        <RelationshipTracker state={relationship} />

        <ProfileTabs active={tab} onChange={setTab} postsCount={clips.length} />

        {tab === 'about' ? (
          <AboutTab character={character} attributes={attributes} />
        ) : (
          <PostsTab
            clips={clips}
            characterId={character.id}
            resumeUnlockAssetId={resumeUnlock}
            onResumeHandled={() => {
              const next = new URLSearchParams(params);
              next.delete('unlock');
              setParams(next, { replace: true });
            }}
            onOpenClip={(index) => setViewer({ items: postItems, index })}
          />
        )}
      </div>

      {viewer && (
        <MediaViewer
          items={viewer.items}
          startIndex={viewer.index}
          label={character.displayName}
          onClose={() => setViewer(null)}
          /**
           * Her clips open WHOLE, the way the Posts tile and Admin show them.
           *
           * Without this the enlarged view put a video in a fixed 4/5 box and
           * cropped it, so tapping a tile that had just been fixed to show the
           * whole frame cropped it again. Video only: her IMAGES keep the 4/5
           * frame this viewer has always given them.
           */
          videoFit="contain"
        />
      )}
      <PremiumFunnel open={funnelOpen} surface="premium_gate" startAt="plans" onClose={() => setFunnelOpen(false)} />
    </div>
  );
}

/**
 * What the profile's Premium button does -- or null for no button.
 *
 * DECIDED BY THE SERVER'S TIER, never guessed. A Premium member has nothing to
 * upgrade to, so gets no button (it used to show to everyone and open a
 * placeholder sheet). A signed-in Free customer opens the real Premium funnel;
 * a signed-out visitor is sent to sign in first, as Chat does. While the
 * economy is loading, or when it is unavailable or switched off, there is no
 * button: better a moment without it than flashing it at a member.
 */
export function upgradeAction(
  economy: CustomerEconomyState,
  actions: { openFunnel: () => void; signIn: () => void },
): (() => void) | null {
  if (economy.status === 'signed-out') return actions.signIn;
  if (economy.status !== 'ready') return null;
  return commercialTier(economy.overview) === 'free' ? actions.openFunnel : null;
}
