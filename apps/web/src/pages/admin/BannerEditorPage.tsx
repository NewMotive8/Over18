import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  bannerEffectiveState,
  BANNER_AUDIENCES,
  type BannerDestinationKind,
  type BannerProblem,
} from '@over18/shared';
import {
  ApiRequestError,
  API_URL,
  homeBannersApi,
  type BannerCreativeRequirements,
  type BannerCreativeView,
  type BannerDestinationOptions,
  type HomeBannerView,
} from '../../lib/api';
import {
  audienceLabel,
  bannerDraftFrom,
  bannerFormFromView,
  creativeRequirementText,
  dimensionsLabel,
  emptyBannerForm,
  formatBytes,
  matchesRecommendedAspect,
  problemMessage,
  scheduleSummary,
  stateLabel,
  wallTimeToInstant,
  type BannerFormState,
} from '../../admin/bannerBoard';
import { HOME_SLOTS } from '../../admin/homeBoard';
import ConfirmDialog from '../../admin/ConfirmDialog';
import PublishingTabs from '../../admin/PublishingTabs';
import { StateChip } from './BannersPage';

/**
 * Admin → Banners → editor (US-102.3).
 *
 * Form on the left, LIVE PREVIEW on the right. The preview renders the real
 * uploaded creative, the real copy and the resolved destination, and states
 * what the app would do with this banner right now — computed with the SAME
 * bannerEffectiveState the server uses, from @over18/shared, so the preview
 * cannot promise something the eligibility query would refuse.
 *
 * NO VERSIONED PUBLISHING. Editing a published banner changes what is live the
 * moment it is saved. That is a product decision for this ticket, and the
 * editor says so on screen rather than leaving it to be discovered.
 *
 * The creative uploader shows the requirements BEFORE a file is chosen, built
 * from the server's own values so the rules on screen cannot drift from the
 * rules enforced. Dimensions are reported when the format exposes them and the
 * 16:9 note is guidance — this product has no dimension rule to enforce.
 */

type Notice = { kind: 'error' | 'success' | 'info'; text: string } | null;

/**
 * The form shape and its mapping to and from the wire now live in
 * admin/bannerBoard, where node tests can reach them.
 */
type FormState = BannerFormState;

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const EMPTY_FORM = (): FormState => emptyBannerForm(browserZone());

export default function BannerEditorPage() {
  const { bannerId } = useParams<{ bannerId: string }>();
  const isNew = !bannerId || bannerId === 'new';
  const navigate = useNavigate();

  const [banner, setBanner] = useState<HomeBannerView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creative, setCreative] = useState<BannerCreativeView | null>(null);
  const [options, setOptions] = useState<BannerDestinationOptions | null>(null);
  const [requirements, setRequirements] = useState<BannerCreativeRequirements | null>(null);

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [destinations, rules] = await Promise.all([
        homeBannersApi.destinations(),
        homeBannersApi.requirements(),
      ]);
      setOptions(destinations);
      setRequirements(rules);
      if (isNew) return;
      const existing = await homeBannersApi.get(bannerId!);
      setBanner(existing);
      setCreative(existing.creative);
      setForm(bannerFormFromView(existing, browserZone()));
    } catch (err) {
      setLoadError(
        err instanceof ApiRequestError && err.status === 404
          ? 'That banner no longer exists.'
          : err instanceof Error
            ? err.message
            : "Couldn't load this banner.",
      );
    }
  }, [bannerId, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------- derived preview state ---------------- */

  /**
   * What the app would do with this banner RIGHT NOW, from the same state
   * machine the server runs. Problems are recomputed locally from what is on
   * screen so the preview reacts as the operator types — an unsaved edit that
   * clears a broken destination stops showing the warning immediately.
   */
  const previewProblems = useMemo<BannerProblem[]>(() => {
    const problems: BannerProblem[] = [];
    if (!form.creativeId) problems.push('creative_missing');
    if (form.destinationKind === 'category' && !form.destinationCategoryId) {
      problems.push('destination_missing');
    }
    if (form.destinationKind === 'character' && !form.destinationCharacterId) {
      problems.push('destination_missing');
    }
    if (form.destinationKind === 'content' && !form.destinationAssetId) {
      problems.push('destination_missing');
    }
    if (form.destinationKind === 'external') {
      const url = form.destinationUrl.trim();
      if (!url) problems.push('destination_missing');
      else {
        try {
          if (new URL(url).protocol !== 'https:') problems.push('destination_invalid_url');
        } catch {
          problems.push('destination_invalid_url');
        }
      }
    }
    // Problems the SERVER has told us about that the form cannot see — a
    // category disabled elsewhere, a creative whose file vanished.
    for (const problem of banner?.problems ?? []) {
      if (problem === 'destination_unavailable' || problem === 'creative_invalid') {
        problems.push(problem);
      }
    }
    return problems;
  }, [form, banner]);

  const previewState = useMemo(
    () =>
      bannerEffectiveState(
        {
          status: banner?.status ?? 'draft',
          startsAt: wallTimeToInstant(form.startLocal, form.timezone),
          endsAt: wallTimeToInstant(form.endLocal, form.timezone),
          problems: previewProblems,
        },
        new Date(),
      ),
    [banner, form, previewProblems],
  );

  const destinationPreview = useMemo(() => {
    switch (form.destinationKind) {
      case 'category':
        return options?.categories.find((c) => c.id === form.destinationCategoryId)?.name ?? null;
      case 'character':
        return (
          options?.characters.find((c) => c.id === form.destinationCharacterId)?.displayName ?? null
        );
      case 'content':
        return form.destinationAssetId ? 'a content item' : null;
      case 'external':
        return form.destinationUrl.trim() || null;
      default:
        return null;
    }
  }, [form, options]);

  /* ---------------- actions ---------------- */

  const draftPayload = () => bannerDraftFrom(form);

  async function act(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    setFieldError(null);
    try {
      await action();
      if (success) setNotice({ kind: 'success', text: success });
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const body = err as ApiRequestError & { field?: string };
        setFieldError(body.field ? { field: body.field, message: err.message } : null);
        setNotice({ kind: 'error', text: err.message });
      } else {
        setNotice({ kind: 'error', text: failure });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) return;
    await act(
      async () => {
        if (isNew) {
          const created = await homeBannersApi.create(draftPayload());
          navigate(`/admin/publishing/banners/${created.id}`, { replace: true });
          setBanner(created);
        } else {
          const updated = await homeBannersApi.update(bannerId!, draftPayload());
          setBanner(updated);
          setCreative(updated.creative);
        }
      },
      "Couldn't save this banner.",
      isNew
        ? 'Draft created. It is not public until you publish it.'
        : banner?.status === 'published'
          ? 'Saved — the live banner has been updated.'
          : 'Draft saved. It is not public until you publish it.',
    );
  }

  async function publish() {
    if (isNew) return;
    await act(
      async () => {
        setBanner(await homeBannersApi.publish(bannerId!));
      },
      "Couldn't publish this banner.",
      'Published.',
    );
  }

  async function unpublish() {
    if (isNew) return;
    await act(
      async () => {
        setBanner(await homeBannersApi.unpublish(bannerId!));
      },
      "Couldn't unpublish this banner.",
      'Unpublished. The banner and its creative are kept.',
    );
  }

  async function remove() {
    if (isNew) return;
    const ok = await act(
      async () => {
        await homeBannersApi.remove(bannerId!);
      },
      "Couldn't delete this banner.",
    );
    if (ok) navigate('/admin/publishing/banners');
  }

  async function upload(file: File) {
    setUploading(true);
    setNotice(null);
    try {
      const uploaded = await homeBannersApi.uploadCreative(file);
      setCreative(uploaded);
      setForm((current) => ({ ...current, creativeId: uploaded.id }));
      setNotice({ kind: 'success', text: 'Creative uploaded. Save the banner to attach it.' });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof ApiRequestError ? err.message : "Couldn't upload that file.",
      });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const aspectOk = creative ? matchesRecommendedAspect(creative) : null;

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <p className="font-medium">{loadError}</p>
          <Link
            to="/admin/publishing/banners"
            className="mt-3 inline-block rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/20"
          >
            Back to banners
          </Link>
        </div>
      </div>
    );
  }

  const loading = !options || !requirements || (!isNew && !banner);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-4">
        <Link
          to="/admin/publishing/banners"
          className="text-xs font-medium text-neutral-400 hover:text-neutral-200"
        >
          ← All banners
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-neutral-100">
            {isNew ? 'New banner' : banner?.title || 'Banner'}
          </h1>
          {banner && <StateChip state={banner.state} />}
        </div>
      </header>

      <PublishingTabs />

      {banner?.status === 'published' && (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/90">
          This banner is published. Saving a change here updates what people see straight away —
          there is no separate draft copy.
        </p>
      )}

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            notice.kind === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : notice.kind === 'info'
                ? 'border-neutral-700 bg-neutral-900 text-neutral-300'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      {loading ? (
        <div aria-busy="true" className="grid gap-6 lg:grid-cols-2">
          <div className="h-96 animate-pulse rounded-2xl border border-neutral-800 bg-neutral-900/50" />
          <div className="h-96 animate-pulse rounded-2xl border border-neutral-800 bg-neutral-900/50" />
          <span className="sr-only">Loading the banner editor…</span>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ---------------- form ---------------- */}
          <form onSubmit={save} className="min-w-0 space-y-5">
            <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 className="text-sm font-semibold text-neutral-200">Creative</h2>
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                {creativeRequirementText(requirements!)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-600">
                Banner artwork is its own thing — it is not added to a character&apos;s library and
                does not go through content review.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept={requirements!.acceptedMimeTypes.join(',')}
                  disabled={uploading || busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                  className="text-xs text-neutral-400 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-neutral-900 hover:file:bg-white"
                />
                {uploading && <span className="text-xs text-neutral-400">Uploading…</span>}
              </div>

              {creative && (
                <p className="mt-2 text-[11px] text-neutral-500">
                  {creative.originalName ?? 'Uploaded creative'} · {formatBytes(creative.byteSize)}
                  {dimensionsLabel(creative) && ` · ${dimensionsLabel(creative)}`}
                  {aspectOk === false && (
                    <span className="text-amber-300/90">
                      {' '}
                      · not 16:9 — allowed, but it may be cropped on Home
                    </span>
                  )}
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 className="text-sm font-semibold text-neutral-200">Copy</h2>
              <div className="mt-3 space-y-3">
                <Field label="Title" error={fieldError?.field === 'title' ? fieldError.message : null}>
                  <input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    maxLength={120}
                    required
                    className={inputClass}
                  />
                </Field>
                <Field label="Subtitle (optional)">
                  <input
                    value={form.subtitle}
                    onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                    maxLength={200}
                    className={inputClass}
                  />
                </Field>
                <Field label="Button text (optional)">
                  <input
                    value={form.ctaLabel}
                    onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })}
                    maxLength={40}
                    className={inputClass}
                  />
                </Field>
              </div>
            </section>

            <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 className="text-sm font-semibold text-neutral-200">Where it goes</h2>
              <div className="mt-3 space-y-3">
                <Field label="Destination type">
                  <select
                    value={form.destinationKind}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        destinationKind: e.target.value as BannerDestinationKind,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="category">App category</option>
                    <option value="character">Character</option>
                    <option value="content">Content item</option>
                    <option value="external">External link</option>
                  </select>
                </Field>

                {form.destinationKind === 'category' && (
                  <Field
                    label="Category"
                    error={
                      fieldError?.field === 'destinationCategoryId' ? fieldError.message : null
                    }
                  >
                    <select
                      value={form.destinationCategoryId}
                      onChange={(e) => setForm({ ...form, destinationCategoryId: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">Choose a category…</option>
                      {options!.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {form.destinationKind === 'character' && (
                  <Field label="Character">
                    <select
                      value={form.destinationCharacterId}
                      onChange={(e) => setForm({ ...form, destinationCharacterId: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">Choose a character…</option>
                      {options!.characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {form.destinationKind === 'content' && (
                  <Field label="Content item">
                    <select
                      value={form.destinationAssetId}
                      onChange={(e) => setForm({ ...form, destinationAssetId: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">Choose approved content…</option>
                      {options!.content.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.characterName} · {item.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {form.destinationKind === 'external' && (
                  <Field
                    label="Link"
                    error={fieldError?.field === 'destinationUrl' ? fieldError.message : null}
                    hint="Must start with https://. We check the address is well formed, not that the page works."
                  >
                    <input
                      value={form.destinationUrl}
                      onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })}
                      placeholder="https://example.com/feature"
                      className={inputClass}
                    />
                  </Field>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 className="text-sm font-semibold text-neutral-200">Where it appears</h2>
              <div className="mt-3">
                <Field
                  label="Home slot"
                  hint="Home has two banner places. Moving a banner sends it to the end of the slot it arrives in; the order within each slot is set on the banners list."
                >
                  <select
                    value={form.slot}
                    onChange={(e) =>
                      setForm({ ...form, slot: e.target.value as FormState['slot'] })
                    }
                    className={inputClass}
                  >
                    {HOME_SLOTS.map((slot) => (
                      <option key={slot.key} value={slot.key}>
                        {slot.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                  {HOME_SLOTS.find((s) => s.key === form.slot)?.hint}
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 className="text-sm font-semibold text-neutral-200">Who sees it, and when</h2>
              <div className="mt-3 space-y-3">
                <Field label="Audience">
                  <select
                    value={form.audience}
                    onChange={(e) =>
                      setForm({ ...form, audience: e.target.value as FormState['audience'] })
                    }
                    className={inputClass}
                  >
                    {BANNER_AUDIENCES.map((value) => (
                      <option key={value} value={value}>
                        {audienceLabel(value)}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Starts (optional)"
                    error={fieldError?.field === 'startsAt' ? fieldError.message : null}
                  >
                    <input
                      type="datetime-local"
                      value={form.startLocal}
                      onChange={(e) => setForm({ ...form, startLocal: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Ends (optional)"
                    error={fieldError?.field === 'endsAt' ? fieldError.message : null}
                  >
                    <input
                      type="datetime-local"
                      value={form.endLocal}
                      onChange={(e) => setForm({ ...form, endLocal: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                </div>

                <Field
                  label="Time zone"
                  error={fieldError?.field === 'scheduleTimezone' ? fieldError.message : null}
                  hint="Times above are read in this zone. It switches on and off by itself — nothing to run."
                >
                  <input
                    value={form.timezone}
                    onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                    placeholder="Europe/London"
                    className={inputClass}
                  />
                </Field>
              </div>
            </section>

            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy || !form.title.trim()}
                className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : isNew ? 'Create draft' : 'Save changes'}
              </button>
              {!isNew && banner?.status !== 'published' && (
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={busy}
                  className="rounded-lg border border-emerald-500/40 px-3.5 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  Publish
                </button>
              )}
              {!isNew && banner?.status === 'published' && (
                <button
                  type="button"
                  onClick={() => void unpublish()}
                  disabled={busy}
                  className="rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                >
                  Unpublish
                </button>
              )}
              {!isNew && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className="rounded-lg border border-neutral-800 px-3.5 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          </form>

          {/* ---------------- live preview ---------------- */}
          <aside aria-labelledby="banner-preview-heading" className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <h2 id="banner-preview-heading" className="text-sm font-semibold text-neutral-200">
                Live preview
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                The real creative and copy. How Home arranges banners is decided separately.
              </p>

              <div className="mt-4 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950">
                <div className="relative aspect-video w-full bg-neutral-900">
                  {creative && creative.mediaType === 'video' ? (
                    <video
                      src={`${API_URL}${creative.fileUrl}`}
                      muted
                      loop
                      autoPlay
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  ) : creative ? (
                    <img
                      src={`${API_URL}${creative.fileUrl}`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-600">
                      No creative yet
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                    <p className="text-base font-semibold text-white">
                      {form.title.trim() || 'Banner title'}
                    </p>
                    {form.subtitle.trim() && (
                      <p className="mt-0.5 text-xs text-white/80">{form.subtitle}</p>
                    )}
                    {form.ctaLabel.trim() && (
                      <span className="mt-2 inline-block rounded-full bg-white px-3 py-1 text-xs font-medium text-neutral-900">
                        {form.ctaLabel}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <dl className="mt-4 space-y-2 text-xs">
                <Row label="Right now">
                  <span
                    className={
                      previewState === 'live'
                        ? 'text-emerald-300'
                        : previewState === 'needs_attention'
                          ? 'text-amber-300'
                          : 'text-neutral-300'
                    }
                  >
                    {stateLabel(previewState)}
                    {previewState === 'draft' && ' — not public until you publish'}
                  </span>
                </Row>
                <Row label="Goes to">
                  <span className="text-neutral-300">
                    {destinationPreview ?? <span className="text-amber-300">not chosen yet</span>}
                  </span>
                </Row>
                <Row label="Audience">
                  <span className="text-neutral-300">{audienceLabel(form.audience)}</span>
                </Row>
                <Row label="Schedule">
                  <span className="text-neutral-300">
                    {scheduleSummary({
                      startsAt: wallTimeToInstant(form.startLocal, form.timezone),
                      endsAt: wallTimeToInstant(form.endLocal, form.timezone),
                      scheduleTimezone: form.timezone,
                    })}
                  </span>
                </Row>
              </dl>

              {previewProblems.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {previewProblems.map((problem) => (
                    <li
                      key={problem}
                      className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] leading-snug text-amber-200/90"
                    >
                      {problemMessage(problem)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          open
          tone="danger"
          title="Delete this banner?"
          body="The banner is removed for good. Its creative file is kept and stays available for another banner, and its destination is not affected."
          confirmLabel="Delete banner"
          cancelLabel="Keep it"
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}

const inputClass =
  'mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400';

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs text-neutral-400">
      {label}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-600">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] text-red-300">{error}</span>}
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
