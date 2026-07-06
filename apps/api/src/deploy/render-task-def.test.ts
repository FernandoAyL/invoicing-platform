import { describe, expect, it } from 'vitest';
import { renderTaskDef, type TaskDefinitionTemplate } from './render-task-def.ts';

function baseTemplate(): TaskDefinitionTemplate {
  return {
    family: 'invoicing-api',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:111111111111:task-definition/invoicing-api:7',
    revision: 7,
    status: 'ACTIVE',
    requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.docker-remote-api.1.18' }],
    compatibilities: ['FARGATE'],
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'arn:aws:iam::111111111111:role/deploy',
    networkMode: 'awsvpc',
    containerDefinitions: [
      { name: 'api', image: '111111111111.dkr.ecr.us-east-1.amazonaws.com/invoicing-api:old-sha' },
      { name: 'sidecar', image: 'datadog/agent:latest' },
    ],
  };
}

describe('renderTaskDef', () => {
  it('substitutes the image for the named container', () => {
    const rendered = renderTaskDef({
      template: baseTemplate(),
      image: '111111111111.dkr.ecr.us-east-1.amazonaws.com/invoicing-api:new-sha',
      containerName: 'api',
    });

    const api = rendered.containerDefinitions.find((c) => c.name === 'api');
    expect(api?.image).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/invoicing-api:new-sha');
  });

  it('only touches the named container when others are present', () => {
    const rendered = renderTaskDef({
      template: baseTemplate(),
      image: 'new-image',
      containerName: 'api',
    });

    const sidecar = rendered.containerDefinitions.find((c) => c.name === 'sidecar');
    expect(sidecar?.image).toBe('datadog/agent:latest');
  });

  it('throws when the named container is absent', () => {
    expect(() =>
      renderTaskDef({
        template: baseTemplate(),
        image: 'new-image',
        containerName: 'does-not-exist',
      }),
    ).toThrow(/does-not-exist/);
  });

  it('does not mutate the original template', () => {
    const template = baseTemplate();
    const snapshot = JSON.parse(JSON.stringify(template));

    renderTaskDef({ template, image: 'new-image', containerName: 'api' });

    expect(template).toEqual(snapshot);
  });

  it('strips read-only fields that register-task-definition rejects', () => {
    const rendered = renderTaskDef({
      template: baseTemplate(),
      image: 'new-image',
      containerName: 'api',
    });

    expect(rendered).not.toHaveProperty('taskDefinitionArn');
    expect(rendered).not.toHaveProperty('revision');
    expect(rendered).not.toHaveProperty('status');
    expect(rendered).not.toHaveProperty('requiresAttributes');
    expect(rendered).not.toHaveProperty('compatibilities');
    expect(rendered).not.toHaveProperty('registeredAt');
    expect(rendered).not.toHaveProperty('registeredBy');
    // Fields that ARE accepted by register-task-definition survive untouched.
    expect(rendered.family).toBe('invoicing-api');
    expect(rendered.networkMode).toBe('awsvpc');
  });
});
