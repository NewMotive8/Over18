import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const shell = read('../components/AppShell.tsx');
const chat = read('./ChatPage.tsx');
const viewport = read('../lib/chatViewport.ts');

/**
 * The chat opened part-way down the page: the document scrolled, and keeping
 * the newest message in view meant scrolling it to its very end -- past the
 * chat, to the site footer -- with her header off the top.
 */
describe('the chat is a fixed screen; only the messages scroll', () => {
  it('on the chat route the shell is exactly the viewport and does not scroll', () => {
    expect(shell).toContain("const isChat = pathname.startsWith('/chat/');");
    expect(shell).toContain("${isChat ? 'h-dvh overflow-hidden' : 'min-h-dvh'}");
    expect(shell).toContain('`mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden ${frame} px-4 pb-3 pt-4`');
  });

  it('every other route still scrolls as a page, exactly as before', () => {
    expect(shell).toContain("`mx-auto flex w-full flex-1 flex-col overflow-y-auto ${frame} ${isImmersive ? '' : 'px-4 pb-8 pt-6'}`");
  });

  it('the footer is left off the screen that has no end to put it at', () => {
    expect(shell).toContain('{!isChat && <SiteFooter />}');
  });

  it('the conversation fills that room, and its message list is the scroller', () => {
    expect(chat).toContain('<section className="flex min-h-0 flex-1 flex-col">');
    expect(chat).toContain('className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-4"');
    expect(chat).not.toContain('min-h-[60dvh]');
  });

  it('pinning asks which element scrolls every time, because an empty chat and a long one differ', () => {
    expect(viewport).toMatch(/const pin = \(force = false\) => \{\s*retarget\(\);/);
    expect(viewport).toContain("list?.addEventListener('load', handleMediaLoad, true);");
  });
});
