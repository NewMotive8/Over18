import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  emptyPackForm,
  emptyPlanForm,
  emptyRulesetForm,
  featureLabel,
  packDraftFromForm,
  packFormFrom,
  planDraftFromForm,
  planFormFrom,
  versionRows,
  type ActionCostRow,
  type PackForm,
  type PlanForm,
} from '../../../admin/economyConfig';
import { configurationView, publishReview, testCatalogue } from '../../../admin/economyTestData';
import PacksScreen, { PackDraftFields, packColumns, packSummary } from './PacksScreen';
import PlansScreen, { PlanDraftFields, planColumns, planSummary } from './PlansScreen';
import { ItemDetail } from './VersionedItemScreen';
import RulesetScreen, { ActionCostsEditor, AllowancesEditor, RewardsEditor } from './RulesetScreen';
import VersionsScreen, { ReviewPanel, VersionsTable } from './VersionsScreen';

/**
 * P1.4 editors, rendered statically (the suite runs no effects). Every value
 * shown comes from the server-shaped test configuration; the screens have none
 * of their own.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const noop = async () => {};

const planSpec = (config = configurationView()) => ({
  noun: 'plan' as const,
  where: 'the Premium page',
  about: 'About plans.',
  items: config.plans,
  summary: planSummary,
  emptyForm: () => emptyPlanForm(config.catalogue, 'USD'),
  formFrom: (v: (typeof config.plans)[number]['versions'][number]) => planFormFrom(v, config.catalogue),
  nameOf: (form: PlanForm) => form.displayName,
  toDraft: planDraftFromForm,
  save: noop,
  discard: noop,
  reload: noop,
  columns: planColumns,
  renderForm: (form: PlanForm, onChange: (form: PlanForm) => void) => <PlanDraftFields form={form} onChange={onChange} />,
});
const packSpec = (config = configurationView()) => ({
  noun: 'pack' as const,
  where: 'the Credits Store',
  about: 'About packs.',
  items: config.packs,
  summary: packSummary,
  emptyForm: () => emptyPackForm('USD'),
  formFrom: packFormFrom,
  nameOf: (form: PackForm) => form.displayName,
  toDraft: packDraftFromForm,
  save: noop,
  discard: noop,
  reload: noop,
  columns: packColumns,
  renderForm: (form: PackForm, onChange: (form: PackForm) => void) => <PackDraftFields form={form} onChange={onChange} />,
});
const nothing = () => {};

describe('Plans', () => {
  it('opens on a list: every plan by name with one plain status, the three steps, and a button to add one', () => {
    const html = render(<PlansScreen config={configurationView()} reload={noop} />);
    expect(html).toContain('+ New plan');
    for (const step of ['Create or edit', 'Save as a draft', 'Publish']) expect(html).toContain(step);
    expect(html.match(/data-testid="item-card"/g)).toHaveLength(1);
    expect(html).toContain('Test plan');
    expect(html).toContain('Live on the site');
    expect(html).toContain('$1.11 · Monthly');
    expect(html).toContain('11 Credits included per billing cycle');
    // The plan has a draft: the list says so and points at where to publish it.
    expect(html).toContain('Unpublished changes saved as a draft');
    expect(html).toContain('href="/admin/economy/versions"');
    // No code to read or type, no stored field names.
    expect(html).not.toMatch(/test_monthly|New plan code|minor units|\(months\)/);
  });

  it("opens a plan on what customers see now, with its draft's values in the form", () => {
    const config = configurationView();
    const html = render(<ItemDetail spec={planSpec(config)} item={config.plans[0]!} onBack={nothing} onNotice={nothing} onCreated={nothing} />);
    expect(html).toContain('← All plans');
    expect(html).toContain('What customers see now');
    expect(html).toContain('$1.11 · Monthly');
    expect(html).toContain('Your unpublished changes');
    expect(html).toContain('value="2.22"'); // the draft's price as money -- not the active one's, not the stored integer
    expect(html).not.toContain('value="222"');
    expect(html).toContain('Customers still see the current version');
    expect(html).toContain('Review &amp; publish →');
    expect(html).toContain('Save draft');
    expect(html).toContain('Discard draft');
    expect(html).toContain('Saving does not change the site.');
    // History is there, folded away, with the read-only internal ID.
    expect(html).toContain('<td>$1.11</td>');
    expect(html).toContain('<td>Monthly</td>');
    expect(html).toContain('Internal ID: <code>test_monthly</code>');
    expect(html).toContain('What do Draft, Published and Retired mean?');
  });

  it('offers no feature controls: nothing reads those flags, so the editor does not present them', () => {
    const html = render(<PlanDraftFields form={emptyPlanForm(testCatalogue)} onChange={() => {}} />);
    expect(html).not.toContain('type="checkbox"');
    for (const key of testCatalogue.planFeatures) {
      expect(html).not.toContain(featureLabel(key));
      expect(html).not.toContain(key);
    }
    expect(html).not.toMatch(/feature/i);
    expect(html).toContain('On sale');
    expect(html).toContain('Retired');
    const config = configurationView();
    const detail = render(<ItemDetail spec={planSpec(config)} item={config.plans[0]!} onBack={nothing} onNotice={nothing} onCreated={nothing} />);
    expect(detail).not.toMatch(/Included features|Voice access/);
  });

  it('asks for a plan in business words: money, a named billing period, Credits per billing cycle', () => {
    const html = render(<PlanDraftFields form={emptyPlanForm(testCatalogue, 'USD')} onChange={() => {}} />);
    for (const option of ['<option value="1">Monthly', '<option value="3">Quarterly', '<option value="12">Annual']) expect(html).toContain(option);
    expect(html).toContain('Credits included per billing cycle');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('>$</span>');
    expect(html).not.toMatch(/minor|\(months\)|price_minor|billing_period/i);
    // A plan saved with another term keeps it, as its own option.
    const other = render(<PlanDraftFields form={{ ...emptyPlanForm(testCatalogue, 'USD'), billingPeriodMonths: '6' }} onChange={() => {}} />);
    expect(other).toContain('Every 6 months (current)');
  });

  it('a new plan is a blank form with no code to type, and says it will not be on the site until published', () => {
    const html = render(<ItemDetail spec={planSpec()} item={null} onBack={nothing} onNotice={nothing} onCreated={nothing} />);
    expect(html).toContain('New plan');
    expect(html).toContain('Customers will not see the new plan until you publish it.');
    expect(html).toContain('Save draft');
    expect(html).not.toContain('Discard draft');
    expect(html).not.toMatch(/Internal ID|plan code/i);
  });

  it('a plan without a draft offers one clear button to change it', () => {
    const config = configurationView();
    config.plans[0]!.versions = config.plans[0]!.versions.filter((v) => v.state !== 'draft');
    const html = render(<ItemDetail spec={planSpec(config)} item={config.plans[0]!} onBack={nothing} onNotice={nothing} onCreated={nothing} />);
    expect(html).toContain('Edit this plan');
    expect(html).toContain('nothing changes on the');
    expect(html).not.toContain('Save draft');
    expect(html).not.toContain('Review &amp; publish');
  });
});

describe('Credit packs', () => {
  it('lists packs by name with what a customer gets, and whether each is on the site', () => {
    const html = render(<PacksScreen config={configurationView()} reload={noop} />);
    expect(html).toContain('+ New pack');
    expect(html).toContain('Test pack');
    expect(html).toContain('12 Credits');
    expect(html).toContain('$0.33');
    expect(html).toContain('Live on the site');
    expect(html).toContain('A published change is scheduled to start later');
    expect(html).not.toContain('test_small');
  });

  it('opens a pack on its live values, its history by state, and a button to edit it', () => {
    const config = configurationView();
    const html = render(<ItemDetail spec={packSpec(config)} item={config.packs[0]!} onBack={nothing} onNotice={nothing} onCreated={nothing} />);
    for (const state of ['Scheduled', 'Published', 'Replaced']) expect(html).toContain(state);
    expect(html).toContain('<td>$0.33</td>');
    expect(html).toContain('Edit this pack');
  });

  it('a retired pack says so plainly', () => {
    const config = configurationView();
    config.packs[0]!.versions = config.packs[0]!.versions.map((v) => ({ ...v, isPurchasable: false }));
    const html = render(<PacksScreen config={config} reload={noop} />);
    expect(html).toContain('Retired — not on sale');
  });

  it('asks for a pack in business words', () => {
    const html = render(<PackDraftFields form={emptyPackForm('USD')} onChange={() => {}} />);
    for (const label of ['Price', 'Regular price', 'Position in the store', 'Bonus Credits', 'On sale', 'Retired']) expect(html).toContain(label);
    expect(html).not.toMatch(/minor|Ladder position|was price/i);
  });
});

describe('the ruleset: action costs, allowances and rewards', () => {
  it('offers to start a draft from the active ruleset, or an empty one', () => {
    const html = render(<RulesetScreen config={configurationView()} part="action-costs" reload={noop} onNotice={() => {}} />);
    expect(html).toContain('No open ruleset draft.');
    expect(html).toContain('Start a draft from v1');
    expect(html).toContain('Start an empty draft');
  });

  it('action costs: actions and tiers from the catalogue, the unit it states, a duration only where it has tiers', () => {
    const rows: ActionCostRow[] = [
      { actionType: 'voice_call', qualityTier: 'standard', maxDurationSeconds: '', creditCost: '5', enabled: true },
      { actionType: 'video', qualityTier: 'high', maxDurationSeconds: '15', creditCost: '9', enabled: false },
    ];
    const html = render(<ActionCostsEditor rows={rows} catalogue={testCatalogue} onChange={() => {}} />);
    for (const action of Object.keys(testCatalogue.actions)) expect(html).toContain(`<option value="${action}"`);
    expect(html).toContain('per_minute');
    expect(html).toContain('no duration tiers');
    expect(html).toContain('aria-label="Max duration 2"');
    expect(html).not.toContain('aria-label="Max duration 1"');
  });

  it('allowances: one field per catalogue allowance; rewards: blank cap reads as once', () => {
    const allowances = render(<AllowancesEditor allowances={emptyRulesetForm(testCatalogue).allowances} onChange={() => {}} />);
    for (const key of testCatalogue.allowances) expect(allowances).toContain(key);
    const rewards = render(<RewardsEditor rows={[{ rewardKey: 'test_referral', credits: '3', perUserCap: '', enabled: true }]} onChange={() => {}} />);
    expect(rewards).toContain('value="test_referral"');
    expect(rewards).toContain('placeholder="once"');
  });

  it('with a draft open, says that saving saves all three parts', () => {
    const config = configurationView();
    config.rulesets = [...config.rulesets, { ...config.rulesets[0]!, id: 'ruleset-v2', version: 2, state: 'draft', effectiveFrom: null, publishedAt: null, publishedBy: null, publishReason: null }];
    const html = render(<RulesetScreen config={config} part="allowances" reload={noop} onNotice={() => {}} />);
    expect(html).toContain('Ruleset draft v2');
    expect(html).toContain('Saves action costs, allowances and rewards together');
  });
});

describe('Versions & publishing', () => {
  it('lists every version, with a cancel control only for the scheduled one', () => {
    const html = render(<VersionsTable rows={versionRows(configurationView())} onCancel={() => {}} />);
    expect(html.match(/data-testid="version-row"/g)).toHaveLength(6);
    expect(html.match(/Cancel…/g)).toHaveLength(1);
    expect(html).toContain('test reason v2');
  });

  it("shows the server's old -> new review, and requires a reason before publishing", () => {
    const html = render(<ReviewPanel review={publishReview()} form={{ reason: '', when: 'now', scheduledAt: '' }} onForm={() => {}} onPublish={() => {}} busy={false} messages={[]} />);
    expect(html).toContain('Plan “test_monthly”: v1 → v2');
    // The price change is shown; the feature-flag change is not (the editor has no control for it).
    expect(html.match(/data-testid="diff-change"/g)).toHaveLength(1);
    expect(html).not.toMatch(/Voice access|features.voice_access/);
    // With the configuration: the plan by name, the price as money.
    const named = render(<ReviewPanel review={publishReview()} config={configurationView()} form={{ reason: '', when: 'now', scheduledAt: '' }} onForm={() => {}} onPublish={() => {}} busy={false} messages={[]} />);
    expect(named).toContain('Plan “Test plan”: v1 → v2');
    expect(named).toContain('$1.11');
    expect(named).toContain('$2.22');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Publish all drafts…/);
    const withReason = render(<ReviewPanel review={publishReview()} form={{ reason: 'Launch', when: 'now', scheduledAt: '' }} onForm={() => {}} onPublish={() => {}} busy={false} messages={[]} />);
    expect(withReason).not.toMatch(/<button type="submit" disabled=""/);
  });

  it("blocks publishing while the server reports errors, and shows its warnings", () => {
    const review = publishReview({ errors: ['Ruleset: allowances.grace_period_days must be set before publishing.'], warnings: ['Pack b is dearer per Credit than a (USD).'] });
    const html = render(<ReviewPanel review={review} form={{ reason: 'Launch', when: 'now', scheduledAt: '' }} onForm={() => {}} onPublish={() => {}} busy={false} messages={[]} />);
    expect(html).toContain('These must be fixed before anything can be published');
    expect(html).toContain('allowances.grace_period_days must be set before publishing.');
    expect(html).toContain('Pack b is dearer per Credit than a (USD).');
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });

  it('offers scheduling with a time field', () => {
    const html = render(<ReviewPanel review={publishReview()} form={{ reason: 'Later', when: 'scheduled', scheduledAt: '' }} onForm={() => {}} onPublish={() => {}} busy={false} messages={[]} />);
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('Schedule all drafts…');
  });

  it('loads the review from the server rather than assuming one', () => {
    expect(render(<VersionsScreen config={configurationView()} reload={noop} />)).toContain('Loading the review');
  });
});
