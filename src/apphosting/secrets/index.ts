import { FirebaseError } from "../../error";
import * as iam from "../../gcp/iam";
import * as gcsm from "../../gcp/secretManager";
import * as gcb from "../../gcp/cloudbuild";
import * as gce from "../../gcp/computeEngine";
import * as apphosting from "../../gcp/apphosting";
import { FIREBASE_MANAGED } from "../../gcp/secretManager";
import { isFunctionsManaged } from "../../gcp/secretManager";
import * as utils from "../../utils";
import * as prompt from "../../prompt";

/**
 * Finds the explicit service account used for a backend or, for legacy cases,
 * the defaults for GCB and compute.
 */
export function serviceAccountsForBackend(
  projectNumber: string,
  backend: apphosting.Backend,
): string[] {
  if (backend.serviceAccount) {
    return [backend.serviceAccount];
  }
  return [gcb.getDefaultServiceAccount(projectNumber), gce.getDefaultServiceAccount(projectNumber)]
}

/**
 * Grants the corresponding service accounts the necessary access permissions to the provided secret.
 */
export async function grantSecretAccess(
  projectId: string,
  secretName: string,
  accounts: string[],
): Promise<void> {
  const members = accounts.map(a => `serviceAccount:${a}`);
  const newBindings: iam.Binding[] = [
    {
      role: "roles/secretmanager.secretAccessor",
      members,
    },
    // Cloud Build needs the viewer role so that it can list secret versions and pin the Build to the
    // latest version.
    {
      role: "roles/secretmanager.viewer",
      members,
    },
  ];

  let existingBindings;
  try {
    existingBindings = (await gcsm.getIamPolicy({ projectId, name: secretName })).bindings || [];
  } catch (err: any) {
    throw new FirebaseError(
      `Failed to get IAM bindings on secret: ${secretName}. Ensure you have the permissions to do so and try again.`,
      { original: err },
    );
  }

  try {
    // TODO: Merge with existing bindings with the same role
    const updatedBindings = existingBindings.concat(newBindings);
    await gcsm.setIamPolicy({ projectId, name: secretName }, updatedBindings);
  } catch (err: any) {
    throw new FirebaseError(
      `Failed to set IAM bindings ${JSON.stringify(newBindings)} on secret: ${secretName}. Ensure you have the permissions to do so and try again.`,
      { original: err },
    );
  }

  utils.logSuccess(`Successfully set IAM bindings on secret ${secretName}.\n`);
}

/**
 * Ensures a secret exists for use with app hosting, optionally locked to a region.
 * If a secret exists, we verify the user is not trying to change the region and verifies a secret
 * is not being used for both functions and app hosting as their garbage collection is incompatible
 * (client vs server-side).
 * @returns true if a secret was created, false if a secret already existed, and null if a user aborts.
 */
export async function upsertSecret(
  project: string,
  secret: string,
  location?: string,
): Promise<boolean | null> {
  let existing: gcsm.Secret;
  try {
    existing = await gcsm.getSecret(project, secret);
  } catch (err: any) {
    if (err.status !== 404) {
      throw new FirebaseError("Unexpected error loading secret", { original: err });
    }
    await gcsm.createSecret(project, secret, gcsm.labels("apphosting"), location);
    return true;
  }
  const replication = existing.replication?.userManaged;
  if (
    location &&
    (replication?.replicas?.length !== 1 || replication?.replicas?.[0]?.location !== location)
  ) {
    utils.logLabeledError(
      "apphosting",
      "Secret replication policies cannot be changed after creation",
    );
    return null;
  }
  if (isFunctionsManaged(existing)) {
    utils.logLabeledWarning(
      "apphosting",
      `Cloud Functions for Firebase currently manages versions of ${secret}. Continuing will disable ` +
        "automatic deletion of old versions.",
    );
    const stopTracking = await prompt.confirm({
      message: "Do you wish to continue?",
      default: false,
    });
    if (!stopTracking) {
      return null;
    }
    delete existing.labels[FIREBASE_MANAGED];
    await gcsm.patchSecret(project, secret, existing.labels);
  }
  // TODO: consider whether we should prompt a user who has an unmanaged secret to enroll in version control.
  // This may not be a great idea until version control is actually implemented.
  return false;
}
