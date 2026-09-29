import { describe, it, expect } from 'vitest';
import { buildConversationPrompt, parseConversationResult } from './positiveSumConversation';

describe('buildConversationPrompt', () => {
  it('includes the org, date, open opportunities and the JSON contract', () => {
    const prompt = buildConversationPrompt({
      orgName: 'Positive Sum',
      date: '2026-09-29',
      opportunities: [
        { kind: 'goal', title: 'Corn prices', initial_state: 'One buyer', desired_state: 'Better prices', created_by_name: 'Maria' },
        { kind: 'option', title: 'Borrow fruit picker', initial_state: null, policy: 'Return clean', desired_state: 'Fruit picked', created_by_name: 'Juan' },
      ],
    });
    expect(prompt).toContain('Positive Sum');
    expect(prompt).toContain('2026-09-29');
    expect(prompt).toContain('To make collaboration easier and more valuable for farmers.');
    expect(prompt).toContain('Value Diversity');
    expect(prompt).toContain('now "One buyer" → would like "Better prices"');
    expect(prompt).toContain('Borrow fruit picker');
    expect(prompt).toContain('"kind": "human_capital"');
    expect(prompt).toContain('"kind": "asset"');
  });

  it('says when nothing is open', () => {
    expect(buildConversationPrompt({ orgName: 'X', date: 'd', opportunities: [] })).toContain('Nothing is open today');
  });
});

describe('parseConversationResult', () => {
  const json = JSON.stringify({
    version: 1,
    desired_states: [{ now: 'One buyer comes by', would_like: 'Better corn prices' }, { now: '', would_like: 'x' }],
    capabilities: [
      { kind: 'human_capital', narrative: 'Grafted mango for 5 years' },
      { kind: 'asset', name: 'Fruit picker', narrative: 'Aluminum pole, good condition' },
      { kind: 'asset', narrative: 'Oil drum, a bit rusty' },
      { kind: 'other', narrative: 'ignored' },
    ],
  });

  it('reads a fenced block with prose around it', () => {
    const result = parseConversationResult(`Here you go!\n\`\`\`json\n${json}\n\`\`\`\nCopy it back.`);
    expect(result).toEqual({
      desiredStates: [{ now: 'One buyer comes by', would_like: 'Better corn prices' }],
      humanCapital: ['Grafted mango for 5 years'],
      assets: [
        { name: 'Fruit picker', narrative: 'Aluminum pole, good condition' },
        { name: 'Oil drum', narrative: 'Oil drum, a bit rusty' },
      ],
    });
  });

  it('reads bare JSON with text around it', () => {
    const result = parseConversationResult(`Summary: ${json} thanks`);
    expect('error' in result).toBe(false);
  });

  it('explains what went wrong', () => {
    expect(parseConversationResult('no json here')).toHaveProperty('error');
    expect(parseConversationResult('{"desired_states": [')).toHaveProperty('error');
    expect(parseConversationResult('{"desired_states": []}')).toHaveProperty('error');
  });
});
