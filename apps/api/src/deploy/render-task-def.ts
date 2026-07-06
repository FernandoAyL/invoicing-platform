// Pure helper (+ guarded CLI) used by .github/workflows/deploy.yml to turn the
// currently-registered ECS task definition into the payload for a new revision
// that points at the freshly built image. No AWS SDK dependency: the workflow
// shells out to the AWS CLI for the describe/register calls and pipes the JSON
// through this script.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ContainerDefinition {
  name: string;
  image: string;
  [key: string]: unknown;
}

export interface TaskDefinitionTemplate {
  containerDefinitions: ContainerDefinition[];
  [key: string]: unknown;
}

// `aws ecs describe-task-definition` returns these alongside the fields that
// `register-task-definition` actually accepts. Re-submitting them verbatim is
// rejected by the API (they're assigned by ECS on registration), so they must
// be stripped before the JSON is handed back to `register-task-definition`.
const READ_ONLY_FIELDS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
] as const;

export function renderTaskDef({
  template,
  image,
  containerName,
}: {
  template: TaskDefinitionTemplate;
  image: string;
  containerName: string;
}): TaskDefinitionTemplate {
  const rendered = structuredClone(template);

  const container = rendered.containerDefinitions.find((c) => c.name === containerName);
  if (!container) {
    throw new Error(`Container "${containerName}" not found in task definition template`);
  }
  container.image = image;

  for (const field of READ_ONLY_FIELDS) {
    delete rendered[field];
  }

  return rendered;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for --${key}`);
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  const { template: templatePath, image, container: containerName } = args;
  if (!templatePath || !image || !containerName) {
    console.error('Usage: render-task-def.ts --template <path> --image <uri> --container <name>');
    process.exitCode = 1;
    return;
  }

  const template = JSON.parse(readFileSync(templatePath, 'utf-8')) as TaskDefinitionTemplate;
  const rendered = renderTaskDef({ template, image, containerName });
  console.log(JSON.stringify(rendered, null, 2));
}

// Guard so importing this module from the Vitest suite doesn't invoke the CLI.
// Compared via pathToFileURL (not a raw `file://` template) so it matches on
// Windows dev machines too, not just the POSIX CI runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
