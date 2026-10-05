export interface GraphQLTypeRef {
  name?: string | null;
  kind?: string | null;
  ofType?: GraphQLTypeRef | null;
}

export interface GraphQLSchemaField {
  name: string;
  type?: GraphQLTypeRef | null;
  args?: Array<{ name: string; type?: GraphQLTypeRef | null }>;
}

export interface GraphQLSchemaType {
  name: string;
  kind?: string | null;
  fields?: GraphQLSchemaField[] | null;
  inputFields?: GraphQLSchemaField[] | null;
  possibleTypes?: Array<{ name: string }> | null;
}

export interface GitLabCapabilityDiagnostic {
  id: string;
  label: string;
  status: 'supported' | 'unsupported' | 'unknown';
  reason?: string;
  source?: 'GraphQL' | 'REST' | 'GraphQL / REST' | 'GitLab /spend';
}

export type GraphQLSchema = ReadonlyMap<string, GraphQLSchemaType>;

const BASE_TYPES = [
  'Project', 'Namespace', 'Issue', 'Mutation', 'WorkItem',
  'WorkItemWidget', 'WorkItemWidgetHierarchy', 'WorkItemWidgetLinkedItems',
  'WorkItemWidgetLabels', 'WorkItemWidgetAssignees', 'WorkItemWidgetStartAndDueDate',
  'WorkItemWidgetTimeTracking', 'WorkItemTimelog'
];

function namedType(ref?: GraphQLTypeRef | null): string | undefined {
  return ref?.name ?? (ref?.ofType ? namedType(ref.ofType) : undefined);
}

function namedKind(ref?: GraphQLTypeRef | null): string | undefined {
  return ref?.kind ?? (ref?.ofType ? namedKind(ref.ofType) : undefined);
}

function inputObjectNames(type: GraphQLSchemaType | undefined): string[] {
  return (type?.inputFields ?? [])
    .filter((field) => namedKind(field.type) === 'INPUT_OBJECT')
    .flatMap((field) => {
      const name = namedType(field.type);
      return name ? [name] : [];
    });
}

export function buildCapabilityQuery(typeNames: readonly string[]): string {
  const uniqueNames = [...new Set(typeNames)].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  const typeSelection = 'name kind fields(includeDeprecated: true) { name type { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } } args { name type { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } } } } inputFields { name type { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } }';
  const aliases = uniqueNames.map((name, index) =>
    `type${index}: __type(name: "${name}") { ...CapabilityType ${name === 'WorkItemWidget' ? 'possibleTypes { name }' : ''} }`).join(' ');
  return `query IssueCapabilities { ${aliases} } fragment CapabilityType on __Type { ${typeSelection} }`;
}

export function getCapabilityTypeNames(data: Record<string, GraphQLSchemaType | null | undefined>): string[] {
  return Object.values(data).flatMap((type) => type?.name ? [type.name] : []);
}

export function getFollowupCapabilityTypeNames(schema: GraphQLSchema): string[] {
  const names = new Set<string>();
  const addNamed = (field: GraphQLSchemaField | undefined): void => {
    const name = namedType(field?.type);
    if (name) names.add(name);
  };
  const addInputArg = (owner: string, fieldName: string): void => {
    addNamed(schema.get(owner)?.fields?.find((field) => field.name === fieldName)?.args?.find((arg) => arg.name === 'input'));
  };
  const addConnectionTypes = (owner: string, fieldName: string): void => {
    const connectionName = namedType(schema.get(owner)?.fields?.find((field) => field.name === fieldName)?.type);
    if (!connectionName) return;
    names.add(connectionName);
    const connection = schema.get(connectionName);
    for (const name of ['nodes', 'edges', 'pageInfo']) {
      const nestedName = namedType(connection?.fields?.find((field) => field.name === name)?.type);
      if (nestedName) names.add(nestedName);
      if (name === 'edges' && nestedName) {
        const nodeName = namedType(schema.get(nestedName)?.fields?.find((field) => field.name === 'node')?.type);
        if (nodeName) names.add(nodeName);
      }
    }
  };

  addNamed(schema.get('Issue')?.fields?.find((field) => field.name === 'userPermissions'));
  addNamed(schema.get('Project')?.fields?.find((field) => field.name === 'userPermissions'));
  addNamed(schema.get('WorkItem')?.fields?.find((field) => field.name === 'userPermissions'));
  addNamed(schema.get('WorkItemTimelog')?.fields?.find((field) => field.name === 'userPermissions'));
  addConnectionTypes('Issue', 'timelogs');
  addConnectionTypes('WorkItemWidgetTimeTracking', 'timelogs');
  const issueTimelogType = connectionNodeType(schema, 'Issue', 'timelogs');
  const workItemTimelogType = connectionNodeType(schema, 'WorkItemWidgetTimeTracking', 'timelogs') ?? (schema.has('WorkItemTimelog') ? 'WorkItemTimelog' : undefined);
  for (const field of ['user', 'userPermissions']) {
    addNamed(schema.get(issueTimelogType ?? '')?.fields?.find((item) => item.name === field));
    addNamed(schema.get(workItemTimelogType ?? '')?.fields?.find((item) => item.name === field));
  }
  for (const fieldName of ['workItemCreate', 'workItemUpdate', 'timelogCreate', 'timelogDelete']) addInputArg('Mutation', fieldName);

  for (const typeName of ['WorkItemCreateInput', 'WorkItemUpdateInput', 'TimelogCreateInput', 'TimelogDeleteInput']) {
    for (const name of inputObjectNames(schema.get(typeName))) names.add(name);
  }
  for (const fieldName of ['workItemCreate', 'workItemUpdate', 'timelogCreate', 'timelogDelete']) {
    addInputArg('Mutation', fieldName);
  }
  return [...names].sort();
}

export function mergeCapabilityTypes(...batches: readonly GraphQLSchemaType[][]): GraphQLSchema {
  const types = new Map<string, GraphQLSchemaType>();
  for (const batch of batches) for (const type of batch) types.set(type.name, type);
  return types;
}

export function parseCapabilityTypes(data: Record<string, unknown>): GraphQLSchemaType[] {
  const validate = (types: unknown[]): GraphQLSchemaType[] => {
    if (types.some((item) => !item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string' || typeof (item as { kind?: unknown }).kind !== 'string')) {
      throw new Error('GitLab returned a malformed GraphQL capability type.');
    }
    const validTypes = types as GraphQLSchemaType[];
    if (validTypes.some((type) =>
      ((type.kind === 'OBJECT' || type.kind === 'INTERFACE') && !Array.isArray(type.fields)) ||
      (type.kind === 'INPUT_OBJECT' && !Array.isArray(type.inputFields)) ||
      (type.name === 'WorkItemWidget' && !Array.isArray(type.possibleTypes)))) {
      throw new Error('GitLab returned an incomplete GraphQL capability type.');
    }
    return validTypes;
  };
  const schema = data.__schema as { types?: unknown } | undefined;
  if (schema !== undefined) {
    if (!schema || !Array.isArray(schema.types)) throw new Error('GitLab returned an invalid GraphQL schema introspection response.');
    const types = validate(schema.types);
    if (!types.length) throw new Error('GitLab returned an empty GraphQL schema introspection response.');
    return types;
  }
  const types = validate(Object.values(data).filter((item) => item !== null));
  if (!types.length) throw new Error('GitLab returned no GraphQL capability types.');
  return types;
}

function fieldsFor(schema: GraphQLSchema, type: string): string[] {
  return schema.get(type)?.fields?.map((field) => field.name) ?? [];
}

function inputFieldsFor(schema: GraphQLSchema, type: string | undefined): string[] {
  return type ? schema.get(type)?.inputFields?.map((field) => field.name) ?? [] : [];
}

function namedField(schema: GraphQLSchema, type: string, field: string): GraphQLSchemaField | undefined {
  return schema.get(type)?.fields?.find((item) => item.name === field);
}

function namedInputArg(schema: GraphQLSchema, mutation: string): string | undefined {
  return namedType(namedField(schema, 'Mutation', mutation)?.args?.find((arg) => arg.name === 'input')?.type);
}

function isWorkItemWidget(schema: GraphQLSchema, name: string): boolean {
  const widgets = namedType(namedField(schema, 'WorkItem', 'widgets')?.type);
  return !!schema.get(widgets ?? '')?.possibleTypes?.some((type) => type.name === name);
}

function connectionNodeType(schema: GraphQLSchema, owner: string, fieldName: string): string | undefined {
  const connectionName = namedType(namedField(schema, owner, fieldName)?.type);
  const connection = schema.get(connectionName ?? '');
  const nodeName = namedType(namedField(schema, connectionName ?? '', 'nodes')?.type);
  if (nodeName) return nodeName;
  const edgeName = namedType(namedField(schema, connectionName ?? '', 'edges')?.type);
  return namedType(namedField(schema, edgeName ?? '', 'node')?.type);
}

export function detectIssueCapabilities(schema: GraphQLSchema): {
  workItemScope?: 'namespace' | 'project';
  workItemCreatePathField?: 'projectPath' | 'namespacePath';
  issuePermissionFields: string[];
  workItemPermissionFields: string[];
  issuePermissionSource?: 'issue' | 'workItem';
  workItemFields: string[];
  workItemGraphFields: string[];
  workItemTypeList: boolean;
  hierarchy: boolean;
  childMutations: boolean;
  graphWorkItems: boolean;
  graphHierarchy: boolean;
  graphLinkedItems: boolean;
  graphLabels: boolean;
  graphAssignees: boolean;
  graphWorkItemTypes: boolean;
  discussionResolve: boolean;
  startDate: boolean;
  timelogReport: boolean;
  timelogSource?: 'workItem' | 'issue';
  timelogSummary?: boolean;
  timelogUserFields?: string[];
  timelogCreate: boolean;
  timelogCreateDated: boolean;
  timelogCreateSummary: boolean;
  timelogAdminPermission: boolean;
  timelogDelete: boolean;
  createPermission: boolean;
} {
  const namespaceScope = ['fullPath', 'workItem'].every((name) => {
    const field = namedField(schema, 'Namespace', name);
    return name === 'fullPath' ? !!field : !!field?.args?.some((arg) => arg.name === 'iid');
  });
  const projectScope = ['fullPath', 'workItem'].every((name) => {
    const field = namedField(schema, 'Project', name);
    return name === 'fullPath' ? !!field : !!field?.args?.some((arg) => arg.name === 'iid');
  });
  const workItemScope = namespaceScope ? 'namespace' : projectScope ? 'project' : undefined;
  const issuePermissionsType = namedType(namedField(schema, 'Issue', 'userPermissions')?.type);
  const projectPermissionsType = namedType(namedField(schema, 'Project', 'userPermissions')?.type);
  const workItemPermissionsType = namedType(namedField(schema, 'WorkItem', 'userPermissions')?.type);
  const workItemPermissions = fieldsFor(schema, workItemPermissionsType ?? '');
  const issuePermissionFields = fieldsFor(schema, 'Issue').includes('userPermissions')
    ? ['updateIssue', 'adminIssue', 'deleteIssue', 'createNote'].filter((name) => fieldsFor(schema, issuePermissionsType ?? '').includes(name)) : [];
  const issuePermissionSource = issuePermissionFields.length ? 'issue'
    : workItemScope && (workItemPermissions.includes('updateWorkItem') || workItemPermissions.includes('adminWorkItem')) ? 'workItem' : undefined;
  const createInput = namedInputArg(schema, 'workItemCreate');
  const updateInput = namedInputArg(schema, 'workItemUpdate');
  const timelogCreateInput = namedInputArg(schema, 'timelogCreate');
  const timelogDeleteInput = namedInputArg(schema, 'timelogDelete');
  const createInputFields = inputFieldsFor(schema, createInput);
  const updateInputFields = inputFieldsFor(schema, updateInput);
  const createPathField = createInputFields.includes('namespacePath') ? 'namespacePath'
    : createInputFields.includes('projectPath') ? 'projectPath' : undefined;
  const timelogCreateFields = inputFieldsFor(schema, timelogCreateInput);
  const workItemTimelogType = connectionNodeType(schema, 'WorkItemWidgetTimeTracking', 'timelogs')
    ?? (schema.has('WorkItemTimelog') ? 'WorkItemTimelog' : undefined);
  const issueTimelogType = connectionNodeType(schema, 'Issue', 'timelogs');
  const workItemTimelogUserType = namedType(namedField(schema, workItemTimelogType ?? '', 'user')?.type);
  const issueTimelogUserType = namedType(namedField(schema, issueTimelogType ?? '', 'user')?.type);
  const workItemTimelogUserFields = ['id', 'name', 'username'].filter((name) => fieldsFor(schema, workItemTimelogUserType ?? '').includes(name));
  const issueTimelogUserFields = ['id', 'name', 'username'].filter((name) => fieldsFor(schema, issueTimelogUserType ?? '').includes(name));
  const workItemTimelogReport = isWorkItemWidget(schema, 'WorkItemWidgetTimeTracking') && fieldsFor(schema, 'WorkItemWidgetTimeTracking').includes('timelogs')
    && ['id', 'timeSpent', 'spentAt', 'user'].every((name) => fieldsFor(schema, workItemTimelogType ?? '').includes(name))
    && ['id', 'name'].every((name) => workItemTimelogUserFields.includes(name));
  const issueTimelogReport = fieldsFor(schema, 'Issue').includes('timelogs') && ['id', 'timeSpent', 'spentAt', 'user'].every((name) => fieldsFor(schema, issueTimelogType ?? '').includes(name))
    && ['id', 'name'].every((name) => issueTimelogUserFields.includes(name));
  const timelogType = workItemTimelogReport ? workItemTimelogType : issueTimelogReport ? issueTimelogType : undefined;
  const timelogFields = fieldsFor(schema, timelogType ?? '');
  const timelogPermissionType = namedType(namedField(schema, timelogType ?? '', 'userPermissions')?.type);
  const workItemFields = fieldsFor(schema, 'WorkItem');
  const graphWorkItems = !!workItemScope && ['id', 'iid', 'widgets'].every((name) => workItemFields.includes(name));
  const hierarchyWidget = isWorkItemWidget(schema, 'WorkItemWidgetHierarchy') && fieldsFor(schema, 'WorkItemWidgetHierarchy').includes('children');
  const graphHierarchy = graphWorkItems && hierarchyWidget && fieldsFor(schema, 'WorkItemWidgetHierarchy').includes('parent');
  const childCreateWidgetType = namedType(schema.get(createInput ?? '')?.inputFields?.find((field) => field.name === 'hierarchyWidget')?.type);
  const childCreateWidgetFields = inputFieldsFor(schema, childCreateWidgetType);
  const childUpdateWidgetType = namedType(schema.get(updateInput ?? '')?.inputFields?.find((field) => field.name === 'hierarchyWidget')?.type);
  const childUpdateWidgetFields = inputFieldsFor(schema, childUpdateWidgetType);
  const childMutations = graphHierarchy && !!createPathField &&
    ['workItemTypeId', 'title', 'hierarchyWidget'].every((name) => createInputFields.includes(name)) &&
    ['parentId'].every((name) => childCreateWidgetFields.includes(name) && childUpdateWidgetFields.includes(name)) &&
    ['hierarchyWidget', 'stateEvent', 'title', 'descriptionWidget'].every((name) => updateInputFields.includes(name));
  const workItemGraphFields = ['title', 'name', 'state', 'webUrl', 'namespace', 'project', 'workItemType']
    .filter((name) => workItemFields.includes(name));
  const startDateInput = namedType(schema.get(updateInput ?? '')?.inputFields?.find((field) => field.name === 'startAndDueDateWidget')?.type);
  return {
    workItemScope,
    workItemCreatePathField: createPathField,
    issuePermissionFields,
    workItemPermissionFields: workItemPermissions,
    issuePermissionSource,
    workItemFields,
    workItemGraphFields,
    workItemTypeList: !!workItemScope && !!namedField(schema, workItemScope === 'namespace' ? 'Namespace' : 'Project', 'workItemTypes')?.args?.some((arg) => arg.name === 'name'),
    hierarchy: graphWorkItems && hierarchyWidget,
    childMutations,
    graphWorkItems,
    graphHierarchy,
    graphLinkedItems: graphWorkItems && isWorkItemWidget(schema, 'WorkItemWidgetLinkedItems') && fieldsFor(schema, 'WorkItemWidgetLinkedItems').includes('linkedItems'),
    graphLabels: graphWorkItems && isWorkItemWidget(schema, 'WorkItemWidgetLabels') && fieldsFor(schema, 'WorkItemWidgetLabels').includes('labels'),
    graphAssignees: graphWorkItems && isWorkItemWidget(schema, 'WorkItemWidgetAssignees') && fieldsFor(schema, 'WorkItemWidgetAssignees').includes('assignees'),
    graphWorkItemTypes: graphWorkItems && workItemFields.includes('workItemType'),
    discussionResolve: !!namedField(schema, 'Mutation', 'discussionToggleResolve')?.args?.some((arg) => arg.name === 'input'),
    startDate: !!namedField(schema, 'Mutation', 'workItemUpdate') && updateInputFields.includes('startAndDueDateWidget') &&
      inputFieldsFor(schema, startDateInput).includes('startDate') &&
      isWorkItemWidget(schema, 'WorkItemWidgetStartAndDueDate') && fieldsFor(schema, 'WorkItemWidgetStartAndDueDate').includes('startDate'),
    timelogReport: workItemTimelogReport || issueTimelogReport,
    timelogSource: workItemTimelogReport ? 'workItem' : issueTimelogReport ? 'issue' : undefined,
    timelogSummary: timelogFields.includes('summary'),
    timelogUserFields: workItemTimelogReport ? workItemTimelogUserFields : issueTimelogReport ? issueTimelogUserFields : undefined,
    timelogCreate: !!namedField(schema, 'Mutation', 'timelogCreate') && ['issuableId', 'timeSpent'].every((name) => timelogCreateFields.includes(name)),
    timelogCreateDated: !!namedField(schema, 'Mutation', 'timelogCreate') && ['issuableId', 'timeSpent', 'spentAt'].every((name) => timelogCreateFields.includes(name)),
    timelogCreateSummary: !!namedField(schema, 'Mutation', 'timelogCreate') && ['issuableId', 'timeSpent', 'summary'].every((name) => timelogCreateFields.includes(name)),
    timelogAdminPermission: !!timelogPermissionType && fieldsFor(schema, timelogPermissionType).includes('adminTimelog'),
    timelogDelete: !!namedField(schema, 'Mutation', 'timelogDelete') && inputFieldsFor(schema, timelogDeleteInput).includes('id'),
    createPermission: !!namedField(schema, 'Project', 'userPermissions') && fieldsFor(schema, projectPermissionsType ?? '').includes('createIssue')
  };
}

export function buildFollowupTypeNames(schema: GraphQLSchema): string[] {
  const names = new Set(getFollowupCapabilityTypeNames(schema));
  for (const inputName of [...names]) {
    for (const nestedName of inputObjectNames(schema.get(inputName))) names.add(nestedName);
  }
  return [...names].sort();
}

export function buildInitialTypeNames(): string[] { return [...BASE_TYPES]; }
