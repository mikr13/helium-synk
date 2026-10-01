import type { SessionSnapshot, SessionWindow } from '../sync-core/src/sessions';
export function sessionWindow(count = 3, title = 'Session tab'): SessionWindow {
  const group = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    focused: true,
    state: 'maximized',
    groups: count > 1 ? [{ id: group, title: 'Research', color: 'blue', collapsed: true }] : [],
    tabs: Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(),
      url: `https://example.com/${index}`,
      title: `${title} ${index}`,
      pinned: index === 0,
      active: index === 0,
      ...(index > 0 ? { group_id: group } : {}),
    })),
  };
}
export function sessionSnapshot(revision = 1, windows = [sessionWindow()]): SessionSnapshot {
  return {
    id: crypto.randomUUID(),
    source_id: crypto.randomUUID(),
    source_revision: revision,
    source_name: 'Session source',
    kind: 'current',
    captured_at: '2026-10-01T08:00:00.000Z',
    windows,
  };
}
