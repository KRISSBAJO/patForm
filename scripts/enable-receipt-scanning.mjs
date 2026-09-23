/** Enable GuardDuty scanning only for PatForm receipt objects in the configured bucket.
 * Run with: node --env-file=.env scripts/enable-receipt-scanning.mjs
 * The role policy follows the AWS GuardDuty Malware Protection for S3 IAM template.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GuardDutyClient, CreateMalwareProtectionPlanCommand, GetMalwareProtectionPlanCommand, ListMalwareProtectionPlansCommand } from '@aws-sdk/client-guardduty';
import { S3Client, GetBucketEncryptionCommand } from '@aws-sdk/client-s3';

const bucket = process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION;
if (!bucket || !region) throw new Error('AWS_S3_BUCKET and AWS_REGION are required');
const prefix = 'finance/receipts/';
const roleName = 'PatFormReceiptMalwareScan';
const gd = new GuardDutyClient({ region });
const s3 = new S3Client({ region });
const cli = (...args) => {
  const output = execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return output.trim() ? JSON.parse(output) : null;
};
const account = cli('sts', 'get-caller-identity').Account;

const existing = await gd.send(new ListMalwareProtectionPlansCommand({}));
for (const plan of existing.MalwareProtectionPlans ?? []) {
  const details = await gd.send(new GetMalwareProtectionPlanCommand({ MalwareProtectionPlanId: plan.MalwareProtectionPlanId }));
  if (details.ProtectedResource?.S3Bucket?.BucketName === bucket &&
      details.ProtectedResource.S3Bucket.ObjectPrefixes?.includes(prefix)) {
    console.log(`Receipt scan plan already exists: ${plan.MalwareProtectionPlanId} (${details.Status})`);
    process.exit(0);
  }
}

const encryption = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
const kmsKey = encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
if (!kmsKey?.startsWith('arn:aws:kms:')) throw new Error('Expected a KMS-encrypted bucket with a key ARN');

const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'malware-protection-plan.guardduty.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
try {
  cli('iam', 'get-role', '--role-name', roleName);
} catch {
  cli('iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', JSON.stringify(trust), '--description', 'Scan new PatForm finance receipt uploads');
}

const bucketArn = `arn:aws:s3:::${bucket}`;
const ruleArn = `arn:aws:events:${region}:${account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`;
const policy = {
  Version: '2012-10-17', Statement: [
    { Sid: 'AllowManagedRuleToSendS3EventsToGuardDuty', Effect: 'Allow', Action: ['events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets'], Resource: ruleArn, Condition: { StringLike: { 'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com' } } },
    { Sid: 'AllowGuardDutyToMonitorEventBridgeManagedRule', Effect: 'Allow', Action: ['events:DescribeRule', 'events:ListTargetsByRule'], Resource: ruleArn },
    { Sid: 'AllowPostScanTag', Effect: 'Allow', Action: ['s3:PutObjectTagging', 's3:GetObjectTagging', 's3:PutObjectVersionTagging', 's3:GetObjectVersionTagging'], Resource: `${bucketArn}/${prefix}*` },
    { Sid: 'AllowEnableS3EventBridgeEvents', Effect: 'Allow', Action: ['s3:PutBucketNotification', 's3:GetBucketNotification'], Resource: bucketArn },
    { Sid: 'AllowPutValidationObject', Effect: 'Allow', Action: 's3:PutObject', Resource: `${bucketArn}/malware-protection-resource-validation-object` },
    { Sid: 'AllowCheckBucketOwnership', Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn },
    { Sid: 'AllowMalwareScan', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: `${bucketArn}/${prefix}*` },
    { Sid: 'AllowDecryptForMalwareScan', Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: kmsKey, Condition: { StringLike: { 'kms:ViaService': `s3.${region}.amazonaws.com` } } },
  ],
};
cli('iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'PatFormReceiptMalwareScan', '--policy-document', JSON.stringify(policy));

// IAM propagation is eventually consistent. The token makes retries idempotent.
const clientToken = randomUUID();
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const created = await gd.send(new CreateMalwareProtectionPlanCommand({
      ClientToken: clientToken,
      ProtectedResource: { S3Bucket: { BucketName: bucket, ObjectPrefixes: [prefix] } },
      Role: roleArn,
      Actions: { Tagging: { Status: 'ENABLED' } },
      Tags: { Application: 'PatForm', Purpose: 'finance-receipts' },
    }));
    console.log(`Receipt scan plan created: ${created.MalwareProtectionPlanId}`);
    process.exit(0);
  } catch (error) {
    if (attempt === 5 || !['BadRequestException', 'AccessDeniedException'].includes(error.name)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
