// Test and local-run surface of @worker/github (`@worker/github/testing`); never imported by Worker code.
export { FakeGitHubOAuth } from './fake-github-oauth';
export type {
  FakeCall,
  FakeComment,
  FakeFault,
  FakeGitHubOAuthOptions,
  FakeIssueSeed,
  FakeMilestone,
  FakeMilestoneSeed,
  FakeMilestoneWrite,
  FakeThreadCommentSeed,
  FakeUser,
} from './fake-github-oauth';
export { mintScopeOf, repositoryOwners } from './mint-scope';
export type { MintScope } from './mint-scope';
