import { expect, it } from 'vitest';
import { CLICK_DATASET } from '@curt/shared';
import dashboard from '../../../grafana/curt-dashboard.json';

interface Target { query?: string; expr?: string; datasource: { uid: string } }
const panels = dashboard.panels as unknown as { title: string; description: string; targets: Target[] }[];
const targets = panels.flatMap((p) => p.targets);
const ae = targets.filter((t) => t.datasource.uid === '${ae}');
const prom = targets.filter((t) => t.datasource.uid === '${prom}');

it('uses only template data sources', () => {
  expect(ae.length + prom.length).toBe(targets.length);
  expect(dashboard.templating.list.map((v) => [v.name, v.type])).toEqual([['ae', 'datasource'], ['prom', 'datasource']]);
});
it('stays far below the daily query limit', () => {
  expect(dashboard.refresh).toBe('5m');
  expect(ae).toHaveLength(8);
  expect(ae.length * 288 + 1440).toBeLessThan(5000);
});
it('weights every Analytics Engine count and limits its time range', () => {
  for (const { query } of ae) {
    expect(query).toContain('SUM(_sample_interval * double1)');
    expect(query).toContain(`FROM ${CLICK_DATASET} WHERE timestamp >=`);
  }
});
it('reads counters only through increase()', () => {
  for (const { expr } of prom.filter((t) => t.expr?.includes('_clicks_total'))) expect(expr).toMatch(/increase\(curt_\w+_total\{[^}]*bot="0"[^}]*\}\[/);
});
it('says it is unverified', () => {
  for (const p of panels) expect(p.description).toContain('Not verified against live services.');
});
