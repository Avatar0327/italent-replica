import { describe, expect, it } from 'vitest';
import { ticket, type NavigationState } from './navigation.js';

// F-376：写确认后的导航票据——页面仍在且领票后没有发生导航才执行。
describe('AC-FE-F376 navigation ticket', () => {
  const calls = () => {
    const seen: string[] = [];
    return { seen, navigate: (view: string) => void seen.push(view) };
  };

  it('页面仍在、代次未变：照常导航', () => {
    const state: NavigationState = { alive: true, key: 'a' };
    const { seen, navigate } = calls();
    ticket(state, navigate)('converting');
    expect(seen).toEqual(['converting']);
  });

  it('领票后页面卸载（后退离开）：丢弃迟到导航', () => {
    const state: NavigationState = { alive: true, key: 'a' };
    const { seen, navigate } = calls();
    const go = ticket(state, navigate);
    state.alive = false;
    go('converting');
    expect(seen).toEqual([]);
  });

  it('领票后页内发生导航（代次变化）：丢弃迟到导航，之后新领的票照常', () => {
    const state: NavigationState = { alive: true, key: 'a' };
    const { seen, navigate } = calls();
    const stale = ticket(state, navigate);
    state.key = 'b';
    stale('converting');
    ticket(state, navigate)('converted');
    expect(seen).toEqual(['converted']);
  });

  it('后退再前进回到同一代次也不复活：卸载即作废', () => {
    const state: NavigationState = { alive: true, key: 'a' };
    const { seen, navigate } = calls();
    const go = ticket(state, navigate);
    state.alive = false;
    state.key = 'a';
    go('converting');
    expect(seen).toEqual([]);
  });
});
