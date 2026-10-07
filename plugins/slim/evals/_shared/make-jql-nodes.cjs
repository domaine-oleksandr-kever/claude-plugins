#!/usr/bin/env node
// Prints a deterministic JQL search result in the Atlassian MCP's `{issues:{nodes:[…]}, context}`
// shape — 50 issues (ELC-1401 …, ~297 KB), each carrying a 1.5–4.2 KB markdown description — for slim's
// row-trim fixtures. Everything is invented: people, ids, hosts and text.
'use strict';

let seed = 1401;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore '
  + 'magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat '
  + 'duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat '
  + 'non proident sunt culpa qui officia deserunt mollit anim id est laborum').split(' ');
const PEOPLE = ['Ada Quill', 'Bram Okafor', 'Cleo Varga', 'Dev Hollis', 'Edda Marsh', 'Finn Arkwright'];
const STATUSES = [['To Do', 'new', 'blue-gray'], ['In Progress', 'indeterminate', 'yellow'], ['QA', 'indeterminate', 'yellow'], ['Done', 'done', 'green']];
const TYPES = ['Task', 'Bug', 'Story'];
const HOST = 'https://acme.example.net';

const sentence = () => {
  const n = 8 + Math.floor(rnd() * 14);
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
};
function description(target) {
  const out = [];
  let len = 0;
  while (len < target) {
    const kind = rnd();
    const block = kind < 0.15 ? `### ${sentence().slice(0, -1)}`
      : kind < 0.45 ? Array.from({ length: 2 + Math.floor(rnd() * 4) }, (_, i) => `${i + 1}. ${sentence()}`).join('\n')
        : kind < 0.6 ? `**${pick(WORDS)} ${pick(WORDS)}**: ${sentence()}`
          : Array.from({ length: 2 + Math.floor(rnd() * 3) }, sentence).join(' ');
    out.push(block);
    len += block.length + 2;
  }
  return out.join('\n\n');
}
const avatars = (id) => Object.fromEntries(['48x48', '24x24', '16x16', '32x32'].map((s) => [s, `${HOST}/avatar/${id}?size=${s.split('x')[0]}&fallback=initials`]));
const person = (name) => {
  const accountId = `acct-${(name.length * 7919).toString(16)}-${name.split(' ')[0].toLowerCase()}`;
  return { self: `${HOST}/rest/api/3/user?accountId=${accountId}`, accountId, avatarUrls: avatars(accountId), displayName: name, active: true, timeZone: 'Europe/London', accountType: 'atlassian' };
};

const nodes = [];
for (let i = 0; i < 50; i++) {
  const key = `ELC-${1401 + i}`;
  const id = String(91001 + i);
  const type = pick(TYPES);
  const [statusName, catKey, colour] = pick(STATUSES);
  const day = String(1 + (i % 28)).padStart(2, '0');
  nodes.push({
    expand: 'operations,versionedRepresentations,editmeta,changelog,renderedFields',
    id,
    self: `${HOST}/rest/api/3/issue/${id}`,
    key,
    fields: {
      summary: sentence().slice(0, 60),
      issuetype: { self: `${HOST}/rest/api/3/issuetype/1000${TYPES.indexOf(type)}`, id: `1000${TYPES.indexOf(type)}`, description: `A ${type.toLowerCase()} tracked by the team.`, iconUrl: `${HOST}/rest/api/2/universal_avatar/view/type/issuetype/avatar/1031${TYPES.indexOf(type)}?size=medium`, name: type, subtask: false, avatarId: 10310 + TYPES.indexOf(type), hierarchyLevel: 0 },
      components: [],
      created: `2026-09-${day}T09:${String(i % 60).padStart(2, '0')}:00.000+0100`,
      description: description(1500 + Math.floor(rnd() * 2600)),
      project: { self: `${HOST}/rest/api/3/project/10042`, id: '10042', key: 'ELC', name: 'Example Lab', projectTypeKey: 'software', simplified: false, avatarUrls: avatars('project-10042'), projectCategory: { self: `${HOST}/rest/api/3/projectCategory/10001`, id: '10001', description: 'Storefront work', name: 'Storefronts' } },
      reporter: person(pick(PEOPLE)),
      priority: { self: `${HOST}/rest/api/3/priority/3`, iconUrl: `${HOST}/images/icons/priorities/medium.svg`, name: 'P3', id: '3' },
      resolution: null,
      labels: [],
      assignee: person(pick(PEOPLE)),
      updated: `2026-10-${String(1 + (i % 6)).padStart(2, '0')}T16:${String(i % 60).padStart(2, '0')}:00.000+0100`,
      status: { self: `${HOST}/rest/api/3/status/1000${i % 4}`, description: '', iconUrl: `${HOST}/images/icons/statuses/generic.png`, name: statusName, id: `1000${i % 4}`, statusCategory: { self: `${HOST}/rest/api/3/statuscategory/${i % 4}`, id: i % 4, key: catKey, colorName: colour, name: statusName } },
    },
    webUrl: `${HOST}/browse/${key}`,
  });
}
const out = {
  issues: { nodes, webUrl: `${HOST}/issues/?jql=project%20%3D%20ELC%20ORDER%20BY%20updated%20DESC`, pageInfo: { hasNextPage: true, endCursor: 'cursor-0000000000000000000000000000000000000050' } },
  context: { atlassianAccountId: 'acct-0000-example', cloudId: '00000000-0000-4000-8000-000000000042', clientName: 'claude-ai', mcpClientName: 'example-mcp-client', toolName: 'searchJiraIssuesUsingJql', endpoint: '/v1/mcp', sessionId: 'session-00000000-0000-0000-0000-000000', invocationId: '00000000-0000-4000-8000-000000000050', env: 'prod', featureFlags: { 'example-flag-one': true, 'example-flag-two': false } },
};
process.stdout.write(JSON.stringify(out));
