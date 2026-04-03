import { describe, it, expect } from 'vitest';
import {
  buildStreamingCard,
  buildCompletedCard,
  buildPermissionCard,
  buildDisabledPermissionCard,
  estimateCardSize,
} from '../../src/feishu/card-builder.js';

describe('card-builder', () => {
  describe('buildStreamingCard', () => {
    it('renders markdown content with streaming indicator', () => {
      const card = buildStreamingCard({
        content: '正在生成代码...',
        projectAlias: 'project-a',
      });

      expect(card.config?.wide_screen_mode).toBe(true);
      expect(card.header?.title.content).toContain('project-a');
      const mdElement = card.elements.find(e => e.tag === 'markdown');
      expect(mdElement).toBeDefined();
      expect((mdElement as any).content).toContain('正在生成代码...');
      const noteElement = card.elements.find(e => e.tag === 'note');
      expect(noteElement).toBeDefined();
    });

    it('truncates content exceeding 16KB byte limit', () => {
      // ASCII 内容：20000 字节 > 16000 字节限制，应被截断
      const longContent = 'x'.repeat(20_000);
      const card = buildStreamingCard({ content: longContent, projectAlias: 'test' });
      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      // 去掉流式光标 ▍ 后检查字节数
      const contentWithoutCursor = mdElement.content.replace(' ▍', '');
      expect(Buffer.byteLength(contentWithoutCursor, 'utf8')).toBeLessThan(20_000);
    });

    it('CJK 内容按字节截断（不按字符数）', () => {
      // 中文每字符 3 字节，6000 字符 = 18000 字节 > 16000 字节限制
      const cjkContent = '中'.repeat(6_000);
      const card = buildStreamingCard({ content: cjkContent, projectAlias: 'test' });
      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      const contentWithoutCursor = mdElement.content.replace(' ▍', '');
      // 截断后字节数应 <= 16000 + suffix 字节
      expect(Buffer.byteLength(contentWithoutCursor, 'utf8')).toBeLessThanOrEqual(16_100);
    });
  });

  describe('buildCompletedCard', () => {
    it('renders final content without streaming indicator', () => {
      const card = buildCompletedCard({
        content: '这是最终回复',
        projectAlias: 'project-a',
      });

      expect(card.header?.template).not.toBe('blue');
      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      expect(mdElement.content).toContain('这是最终回复');
      const noteElement = card.elements.find(e => e.tag === 'note');
      expect(noteElement).toBeUndefined();
    });
  });

  describe('buildPermissionCard', () => {
    it('renders tool name and approve/deny buttons', () => {
      const card = buildPermissionCard({
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        requestId: 'uuid-123',
        projectAlias: 'project-a',
      });

      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      expect(mdElement.content).toContain('Bash');

      const actionElement = card.elements.find(e => e.tag === 'action') as any;
      expect(actionElement).toBeDefined();
      expect(actionElement.actions).toHaveLength(2);

      const allowBtn = actionElement.actions.find((a: any) => a.type === 'primary');
      expect(allowBtn).toBeDefined();
      expect(allowBtn.value.action).toBe('allow');
      expect(allowBtn.value.requestId).toBe('uuid-123');

      const denyBtn = actionElement.actions.find((a: any) => a.type === 'danger');
      expect(denyBtn).toBeDefined();
      expect(denyBtn.value.action).toBe('deny');
      expect(denyBtn.value.requestId).toBe('uuid-123');
    });

    it('shows tool input in code block', () => {
      const card = buildPermissionCard({
        toolName: 'Write',
        toolInput: { file_path: '/tmp/test.ts', content: 'hello' },
        requestId: 'uuid-456',
        projectAlias: 'project-b',
      });

      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      expect(mdElement.content).toContain('file_path');
    });
  });

  describe('buildDisabledPermissionCard', () => {
    it('renders without clickable buttons', () => {
      const card = buildDisabledPermissionCard({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        result: 'allowed',
        projectAlias: 'project-a',
      });

      const actionElement = card.elements.find(e => e.tag === 'action');
      expect(actionElement).toBeUndefined();

      const mdElement = card.elements.find(e => e.tag === 'markdown') as any;
      expect(mdElement.content).toContain('已允许');
    });
  });

  describe('estimateCardSize', () => {
    it('returns approximate byte size of card JSON', () => {
      const card = buildStreamingCard({ content: 'hello', projectAlias: 'test' });
      const size = estimateCardSize(card);
      // 近似值 = content 字节数 + 2000 固定开销，小内容应在 2100 以内
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(2100);
    });

    it('大内容时估算值高于 20KB 阈值', () => {
      // content 已被 truncateContent 截断到 ~16KB，加上 2KB 开销仍低于 20KB
      // 此处直接构造超大内容绕过截断，验证估算函数本身
      const bigContent = 'x'.repeat(25_000);
      // 不经过 buildCompletedCard（会截断），直接构造卡片对象
      const fakeCard = {
        config: { wide_screen_mode: true as const },
        header: { title: { tag: 'plain_text' as const, content: 'test' }, template: 'green' as const },
        elements: [{ tag: 'markdown' as const, content: bigContent }],
      };
      const size = estimateCardSize(fakeCard);
      expect(size).toBeGreaterThan(20 * 1024);
    });
  });
});
