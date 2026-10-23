import rules from './routing-rules.generated.json' with { type: 'json' };
import search from './routing-search.json' with { type: 'json' };

export const routingProfile = rules.profile;
export const routingParameters = { ...search, ...rules.parameters };
export const routingPolicyVersion = `${rules.revision}:${search.pass1coefficient}:${search.pass2coefficient}`;

// The migration preserves this policy's routes, including drafts saved before versioning existed.
const legacyPolicy = '54ce18e1b7abec17c5cdbbf7c0d01d855aaeced39435464fd1c6d0fb8e2f2b38:2:0.7';
export function isRoutingPolicyCurrent(version: string | undefined): boolean {
  return (version ?? legacyPolicy) === routingPolicyVersion;
}
