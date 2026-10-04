import { describe, it, expect } from 'vitest';
import { buildConversationPrompt, parseConversationResult } from './positiveSumConversation';

describe('buildConversationPrompt', () => {
  it('includes the org, date, open opportunities and the JSON contract', () => {
    const prompt = buildConversationPrompt({
      orgName: 'Positive Sum',
      date: '2026-09-29',
      hour: 15,
      opportunities: [
        { kind: 'goal', title: 'Corn prices', initial_state: 'One buyer', desired_state: 'Better prices', created_by_name: 'Maria' },
        { kind: 'option', title: 'Borrow fruit picker', initial_state: null, policy: 'Return clean', desired_state: 'Fruit picked', created_by_name: 'Juan' },
      ],
    });
    expect(prompt).toContain('Positive Sum');
    expect(prompt).toContain('2026-09-29');
    expect(prompt).not.toContain('Mission');
    expect(prompt).toContain('Value Diversity');
    expect(prompt).toContain('support those who support others');
    expect(prompt).toContain('"Hello, or should I say Maayong hapon?"');
    expect(prompt).toContain('the network will look for ways to create value for you');
    expect(prompt).toContain('now "One buyer" → would like "Better prices"');
    expect(prompt).toContain('Borrow fruit picker');
    expect(prompt).toContain('"kind": "human_capital"');
    expect(prompt).not.toContain('"kind": "asset"');
    expect(prompt.indexOf('come to you for help')).toBeLessThan(prompt.indexOf("something you're proud of"));
    expect(prompt.indexOf('Do you see an opportunity')).toBeLessThan(prompt.indexOf('costing you money, time or peace of mind'));
    expect(prompt).toContain('what did I do, and how did it turn out?');
    expect(prompt).toContain("You can't see the app or my records");
  });

  it('greets for the time of day', () => {
    const greet = (hour: number) => buildConversationPrompt({ orgName: 'X', date: 'd', hour, opportunities: [] });
    expect(greet(7)).toContain('Maayong aga');
    expect(greet(12)).toContain('Maayong hapon');
    expect(greet(19)).toContain('Maayong gab-i');
  });

  it('says when nothing is open', () => {
    expect(buildConversationPrompt({ orgName: 'X', date: 'd', hour: 9, opportunities: [] })).toContain('Nothing is open today');
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
