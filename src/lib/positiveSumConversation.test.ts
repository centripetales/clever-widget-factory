import { describe, it, expect } from 'vitest';
import { buildConversationPrompt, parseConversationResult } from './positiveSumConversation';

describe('buildConversationPrompt', () => {
  const prompt = buildConversationPrompt({ orgName: 'Positive Sum', date: '2026-09-29', hour: 15 });

  it('greets for the time of day and carries the background', () => {
    expect(prompt).toContain('Positive Sum');
    expect(prompt).toContain('2026-09-29');
    expect(prompt).toContain('"Hello, or should I say Maayong hapon?"');
    expect(prompt).toContain('Value Diversity');
    expect(prompt).toContain('support those who support others');
    expect(buildConversationPrompt({ orgName: 'X', date: 'd', hour: 8 })).toContain('Maayong aga');
    expect(buildConversationPrompt({ orgName: 'X', date: 'd', hour: 20 })).toContain('Maayong gab-i');
  });

  it('says every question is optional and what the answers are for', () => {
    expect(prompt).toContain('Every question is optional');
    expect(prompt).toContain("answer only what you're comfortable with");
    expect(prompt).toContain('help set up win-win interactions');
    expect(prompt).toContain('move on without pressing');
  });

  it('asks about a typical day, what people come to them for, then where we could improve', () => {
    const order = [
      'What does a typical day look like for you?',
      'What do people usually come to you for help with?',
      'What makes things harder than they need to be around here?',
    ].map(question => prompt.indexOf(question));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain("Don't ask about tools, machines, land");
    expect(prompt).toContain("it doesn't need a solution");
  });

  it('asks for the person\'s own view without showing what others said', () => {
    expect(prompt).toContain("Don't suggest examples or tell me what other people have said");
    expect(prompt).not.toMatch(/affect you too|affects_me|already mentioned/);
  });

  it('no longer asks what the person would like to be different, or lists opportunities', () => {
    expect(prompt).not.toMatch(/like to be different|pay for or trade for|open opportunities|desired_states/);
  });

  it('keeps the rules about the person\'s own words and the JSON contract', () => {
    expect(prompt).toContain('Write down what I say in my own words');
    expect(prompt).toContain("don't ask me to approve your wording");
    expect(prompt).toContain("You can't see the app or my records");
    expect(prompt).toContain('The JSON has exactly the items of that list');
    expect(prompt).toContain('"version": 3');
    expect(prompt).toContain('"typical_day"');
    expect(prompt).toContain('"situations"');
    expect(prompt).toContain('"kind": "human_capital"');
  });
});

describe('parseConversationResult', () => {
  const json = JSON.stringify({
    version: 3,
    typical_day: ' Up at five to feed the goats, then the nursery. ',
    capabilities: [
      { kind: 'human_capital', narrative: 'Grafted mango for 5 years' },
      { kind: 'asset', narrative: 'Oil drum, a bit rusty' },
    ],
    situations: ['The road floods every rainy season', '  '],
  });

  it('reads a fenced block with prose around it', () => {
    expect(parseConversationResult(`Here you go!\n\`\`\`json\n${json}\n\`\`\`\nCopy it back.`)).toEqual({
      typicalDay: 'Up at five to feed the goats, then the nursery.',
      humanCapital: ['Grafted mango for 5 years'],
      situations: ['The road floods every rainy season'],
    });
  });

  it('reads bare JSON with text around it', () => {
    expect('error' in parseConversationResult(`Summary: ${json} thanks`)).toBe(false);
  });

  it('reads a result where the person answered only one thing', () => {
    expect(parseConversationResult('{"typical_day": "Mostly in the field"}'))
      .toEqual({ typicalDay: 'Mostly in the field', humanCapital: [], situations: [] });
  });

  it('still reads results from earlier prompts, leaving out what they would like to be different', () => {
    const earlier = JSON.stringify({
      version: 2, challenges: ['Coconuts are being stolen'], desired_states: ['Better corn prices'],
      capabilities: [{ kind: 'human_capital', narrative: 'SEC compliance.' }],
    });
    expect(parseConversationResult(earlier)).toEqual({
      typicalDay: '', humanCapital: ['SEC compliance.'], situations: ['Coconuts are being stolen'],
    });
  });

  it('explains what went wrong', () => {
    expect(parseConversationResult('no json here')).toHaveProperty('error');
    expect(parseConversationResult('{"situations": [')).toHaveProperty('error');
    expect(parseConversationResult('{"desired_states": ["Better prices"]}')).toHaveProperty('error');
  });
});
