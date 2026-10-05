import type { GraphQLSchemaType } from '../../src/api/graphqlCapabilities';

/** Emulates the selective __type aliases requested by GitLabClient.getIssueCapabilities. */
export function selectedCapabilityData(query: string, input: readonly GraphQLSchemaType[]): Record<string, GraphQLSchemaType | null> {
  // Test schemas omit boilerplate metadata for readability. Real __type and
  // __schema responses always include `kind` and the applicable field list.
  const normalize = (type: GraphQLSchemaType): GraphQLSchemaType => {
    const normalized = structuredClone(type);
    normalized.kind ??= Array.isArray(normalized.inputFields)
      ? 'INPUT_OBJECT'
      : Array.isArray(normalized.possibleTypes) ? 'INTERFACE' : 'OBJECT';
    if ((normalized.kind === 'OBJECT' || normalized.kind === 'INTERFACE') && !Array.isArray(normalized.fields)) normalized.fields = [];
    if (normalized.kind === 'INPUT_OBJECT' && !Array.isArray(normalized.inputFields)) normalized.inputFields = [];
    return normalized;
  };
  const types = new Map(input.map((type) => [type.name, normalize(type)]));
  const field = (owner: string, name: string) => types.get(owner)?.fields?.find((item) => item.name === name);
  const ensure = (name: string, value: GraphQLSchemaType): void => { if (!types.has(name)) types.set(name, normalize(value)); };
  for (const [owner, permissions] of [['Issue', 'IssuePermissions'], ['Project', 'ProjectPermissions'], ['WorkItem', 'WorkItemPermissions'], ['WorkItemTimelog', 'TimelogPermissions']]) {
    const item = field(owner, 'userPermissions');
    if (item && !item.type) item.type = { name: permissions, kind: 'OBJECT' };
  }
  for (const [inputName, input] of types) {
    if (!inputName.endsWith('Input')) continue;
    for (const item of input?.inputFields ?? []) {
      if (item.type) continue;
      const marker = item.name === 'hierarchyWidget' ? 'Hierarchy' : item.name === 'startAndDueDateWidget' ? 'StartAndDueDate' : undefined;
      const nested = marker && [...types.keys()].find((name) => name.startsWith(`WorkItemWidget${marker}`) && name.endsWith('Input'));
      if (nested) item.type = { name: nested, kind: 'INPUT_OBJECT' };
    }
  }
  const widgets = field('WorkItem', 'widgets');
  if (widgets && !widgets.type) widgets.type = { name: 'WorkItemWidget', kind: 'INTERFACE' };
  const widgetNames = [...types.keys()].filter((name) => name.startsWith('WorkItemWidget') && name !== 'WorkItemWidget');
  ensure('WorkItemWidget', { name: 'WorkItemWidget', kind: 'INTERFACE', possibleTypes: widgetNames.map((name) => ({ name })) });
  if (types.has('Namespace') && !field('Namespace', 'fullPath')) types.get('Namespace')!.fields!.push({ name: 'fullPath', type: { name: 'ID', kind: 'SCALAR' } });
  const aliases = [...query.matchAll(/(type\d+):\s*__type\(name:\s*"([A-Za-z_][A-Za-z0-9_]*)"\)/g)];
  return Object.fromEntries(aliases.map((match) => [match[1], types.get(match[2]) ?? null]));
}
