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
    expect(prompt).toContain('Desired state (Maria): "Better prices"');
    expect(prompt).not.toContain('One buyer');
    expect(prompt).not.toMatch(/"now"|What happens now/);
    expect(prompt).toContain('"version": 2');
    expect(prompt).toContain('write each as its own item');
    expect(prompt).toContain('Borrow fruit picker');
    expect(prompt).toContain('"kind": "human_capital"');
    expect(prompt).not.toContain('"kind": "asset"');
    expect(prompt).toContain('What do people usually come to you for help with?');
    expect(prompt).toContain("What's happening around here that we could handle better together?");
    expect(prompt).toContain("it doesn't need a solution");
    expect(prompt).toContain('"situations": [');
    // Things a person owns are added and shared in the app, not asked about here.
    expect(prompt).not.toContain('others might use');
    expect(prompt).toContain("Don't ask about tools, machines, land");
    expect(prompt.indexOf('What would you like to be different')).toBeLessThan(prompt.indexOf("you'd pay for or trade for"));
    expect(prompt).toContain('What did you do, and how did it turn out?');
    expect(prompt).toContain("don't ask me to approve your wording");
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
    version: 2,
    challenges: ['Only one corn buyer comes by', '', 7],
    desired_states: ['Better corn prices', 'Most fruit', '  ', 42],
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
      desiredStates: ['Better corn prices', 'Most fruit'],
      humanCapital: ['Grafted mango for 5 years'],
      challenges: ['Only one corn buyer comes by'],
    });
  });

  it('reads bare JSON with text around it', () => {
    const result = parseConversationResult(`Summary: ${json} thanks`);
    expect('error' in result).toBe(false);
  });

  it('still reads version 1 objects, keeping what the person would like', () => {
    const v1 = JSON.stringify({ version: 1, desired_states: [{ now: 'One buyer', would_like: 'Better prices' }, { now: 'x', would_like: '' }] });
    expect(parseConversationResult(v1)).toEqual({ desiredStates: ['Better prices'], humanCapital: [], challenges: [] });
  });

  it('reads a result that has only situations, under either name', () => {
    expect(parseConversationResult('{"challenges": ["Coconuts are being stolen"]}'))
      .toEqual({ desiredStates: [], humanCapital: [], challenges: ['Coconuts are being stolen'] });
    expect(parseConversationResult('{"situations": ["Coconuts are being stolen"]}'))
      .toEqual({ desiredStates: [], humanCapital: [], challenges: ['Coconuts are being stolen'] });
  });

  it('explains what went wrong', () => {
    expect(parseConversationResult('no json here')).toHaveProperty('error');
    expect(parseConversationResult('{"desired_states": [')).toHaveProperty('error');
    expect(parseConversationResult('{"desired_states": []}')).toHaveProperty('error');
  });
});
