import type { Me, PublicConfig } from '@curt/shared/schemas';
import { api, messageOf, RequestError, whenSignedOut } from './api.ts';
import type { SignInProblem } from './auth.ts';
import { load, save } from './storage.ts';
import { applyAccent } from './theme.svelte.ts';

class Session {
  status = $state<'loading' | 'failed' | 'signed-out' | 'ready'>('loading');
  config = $state.raw<PublicConfig | null>(null);
  me = $state.raw<Me | null>(null);
  hosts = $state.raw<string[]>([]);
  error = $state('');
  problem = $state<SignInProblem | 'ended' | null>(null);
  problemDetail = $state('');

  constructor() {
    whenSignedOut(() => {
      // Only a session that was working can have ended.
      if (this.status === 'ready') this.problem = 'ended';
      this.#clear();
    });
  }
  get siteName(): string { return this.config?.siteName || load('site') || 'Links'; }
  get isAdmin(): boolean { return this.me?.isAdmin ?? false; }

  #clear(): void {
    this.me = null;
    this.status = 'signed-out';
  }

  async loadConfig(): Promise<boolean> {
    this.status = 'loading';
    try {
      this.config = await api.config();
      applyAccent(this.config.accent);
      save('site', this.config.siteName);
      return true;
    } catch (e) {
      this.error = messageOf(e);
      this.status = 'failed';
      return false;
    }
  }

  async loadUser(): Promise<void> {
    this.status = 'loading';
    try {
      const [me, domains] = await Promise.all([api.me(), api.domains()]);
      this.me = me;
      this.hosts = domains.domains.map((d) => d.host);
      this.problem = null;
      this.status = 'ready';
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) this.#clear();
      else {
        this.error = messageOf(e);
        this.status = 'failed';
      }
    }
  }

  async signOut(): Promise<void> {
    await api.signOut();
    this.problem = null;
    this.#clear();
  }
}
export const session = new Session();
