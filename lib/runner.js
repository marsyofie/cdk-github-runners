"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubRunners = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cdk = require("aws-cdk-lib");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const constructs_1 = require("constructs");
const access_1 = require("./access");
const delete_failed_runner_function_1 = require("./delete-failed-runner-function");
const idle_runner_repear_function_1 = require("./idle-runner-repear-function");
const providers_1 = require("./providers");
const secrets_1 = require("./secrets");
const setup_function_1 = require("./setup-function");
const status_function_1 = require("./status-function");
const token_retriever_function_1 = require("./token-retriever-function");
const utils_1 = require("./utils");
const webhook_1 = require("./webhook");
const webhook_redelivery_1 = require("./webhook-redelivery");
/**
 * Create all the required infrastructure to provide self-hosted GitHub runners. It creates a webhook, secrets, and a step function to orchestrate all runs. Secrets are not automatically filled. See README.md for instructions on how to setup GitHub integration.
 *
 * By default, this will create a runner provider of each available type with the defaults. This is good enough for the initial setup stage when you just want to get GitHub integration working.
 *
 * ```typescript
 * new GitHubRunners(this, 'runners');
 * ```
 *
 * Usually you'd want to configure the runner providers so the runners can run in a certain VPC or have certain permissions.
 *
 * ```typescript
 * const vpc = ec2.Vpc.fromLookup(this, 'vpc', { vpcId: 'vpc-1234567' });
 * const runnerSg = new ec2.SecurityGroup(this, 'runner security group', { vpc: vpc });
 * const dbSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'database security group', 'sg-1234567');
 * const bucket = new s3.Bucket(this, 'runner bucket');
 *
 * // create a custom CodeBuild provider
 * const myProvider = new CodeBuildRunnerProvider(
 *   this, 'codebuild runner',
 *   {
 *      labels: ['my-codebuild'],
 *      vpc: vpc,
 *      securityGroups: [runnerSg],
 *   },
 * );
 * // grant some permissions to the provider
 * bucket.grantReadWrite(myProvider);
 * dbSg.connections.allowFrom(runnerSg, ec2.Port.tcp(3306), 'allow runners to connect to MySQL database');
 *
 * // create the runner infrastructure
 * new GitHubRunners(
 *   this,
 *   'runners',
 *   {
 *     providers: [myProvider],
 *   }
 * );
 * ```
 */
class GitHubRunners extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        this.props = props;
        this.extraLambdaEnv = {};
        this.jobsCompletedMetricFiltersInitialized = false;
        this.secrets = new secrets_1.Secrets(this, 'Secrets');
        this.extraLambdaProps = {
            vpc: this.props?.vpc,
            vpcSubnets: this.props?.vpcSubnets,
            allowPublicSubnet: this.props?.allowPublicSubnet,
            securityGroups: this.lambdaSecurityGroups(),
            layers: [],
        };
        this.connections = new aws_cdk_lib_1.aws_ec2.Connections({ securityGroups: this.extraLambdaProps.securityGroups });
        this.createCertificateLayer(scope);
        if (this.props?.providers) {
            this.providers = this.props.providers;
        }
        else {
            this.providers = [
                new providers_1.CodeBuildRunnerProvider(this, 'CodeBuild'),
                new providers_1.LambdaRunnerProvider(this, 'Lambda'),
                new providers_1.FargateRunnerProvider(this, 'Fargate'),
            ];
        }
        if (this.providers.length == 0) {
            throw new Error('At least one runner provider is required');
        }
        this.checkIntersectingLabels();
        this.orchestrator = this.stateMachine(props);
        this.webhook = new webhook_1.GithubWebhookHandler(this, 'Webhook Handler', {
            orchestrator: this.orchestrator,
            secrets: this.secrets,
            access: this.props?.webhookAccess ?? access_1.LambdaAccess.lambdaUrl(),
            providers: this.providers.reduce((acc, p) => {
                acc[p.node.path] = p.labels;
                return acc;
            }, {}),
            requireSelfHostedLabel: this.props?.requireSelfHostedLabel ?? true,
            providerSelector: this.props?.providerSelector,
            extraLambdaProps: this.extraLambdaProps,
            extraLambdaEnv: this.extraLambdaEnv,
        });
        this.redeliverer = new webhook_redelivery_1.GithubWebhookRedelivery(this, 'Webhook Redelivery', {
            secrets: this.secrets,
            extraLambdaProps: this.extraLambdaProps,
            extraLambdaEnv: this.extraLambdaEnv,
        });
        this.setupUrl = this.setupFunction();
        this.statusFunction();
    }
    stateMachine(props) {
        const tokenRetrieverTask = new aws_cdk_lib_1.aws_stepfunctions_tasks.LambdaInvoke(this, 'Get Runner Token', {
            lambdaFunction: this.tokenRetriever(),
            payloadResponseOnly: true,
            resultPath: '$.runner',
        });
        let deleteFailedRunnerFunction = this.deleteFailedRunner();
        const deleteFailedRunnerTask = new aws_cdk_lib_1.aws_stepfunctions_tasks.LambdaInvoke(this, 'Delete Failed Runner', {
            lambdaFunction: deleteFailedRunnerFunction,
            payloadResponseOnly: true,
            resultPath: '$.delete',
            payload: aws_cdk_lib_1.aws_stepfunctions.TaskInput.fromObject({
                runnerName: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
                owner: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.owner'),
                repo: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.repo'),
                installationId: aws_cdk_lib_1.aws_stepfunctions.JsonPath.numberAt('$.installationId'),
                error: aws_cdk_lib_1.aws_stepfunctions.JsonPath.objectAt('$.error'),
            }),
        });
        deleteFailedRunnerTask.addRetry({
            errors: [
                'RunnerBusy',
            ],
            interval: cdk.Duration.minutes(1),
            backoffRate: 1,
            maxAttempts: 60,
        });
        const idleReaper = this.idleReaper();
        const queueIdleReaperTask = new aws_cdk_lib_1.aws_stepfunctions_tasks.SqsSendMessage(this, 'Queue Idle Reaper', {
            queue: this.idleReaperQueue(idleReaper),
            messageBody: aws_cdk_lib_1.aws_stepfunctions.TaskInput.fromObject({
                executionArn: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$$.Execution.Id'),
                runnerName: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
                owner: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.owner'),
                repo: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.repo'),
                installationId: aws_cdk_lib_1.aws_stepfunctions.JsonPath.numberAt('$.installationId'),
                maxIdleSeconds: (props?.idleTimeout ?? cdk.Duration.minutes(5)).toSeconds(),
            }),
            resultPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.DISCARD,
        });
        const providerChooser = new aws_cdk_lib_1.aws_stepfunctions.Choice(this, 'Choose provider');
        for (const provider of this.providers) {
            const providerTask = provider.getStepFunctionTask({
                runnerTokenPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.runner.token'),
                runnerNamePath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
                githubDomainPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.runner.domain'),
                ownerPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.owner'),
                repoPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.repo'),
                registrationUrl: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.runner.registrationUrl'),
                labelsPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.labels'),
            });
            providerChooser.when(aws_cdk_lib_1.aws_stepfunctions.Condition.and(aws_cdk_lib_1.aws_stepfunctions.Condition.stringEquals('$.provider', provider.node.path)), providerTask, {
                comment: `Labels: ${provider.labels.join(', ')}`,
            });
        }
        providerChooser.otherwise(new aws_cdk_lib_1.aws_stepfunctions.Succeed(this, 'Unknown label'));
        const runProviders = new aws_cdk_lib_1.aws_stepfunctions.Parallel(this, 'Run Providers').branch(new aws_cdk_lib_1.aws_stepfunctions.Parallel(this, 'Error Handler').branch(
        // we get a token for every retry because the token can expire faster than the job can timeout
        tokenRetrieverTask.next(providerChooser)).addCatch(
        // delete runner on failure as it won't remove itself and there is a limit on the number of registered runners
        deleteFailedRunnerTask, {
            resultPath: '$.error',
        }));
        if (props?.retryOptions?.retry ?? true) {
            const interval = props?.retryOptions?.interval ?? cdk.Duration.minutes(1);
            const maxAttempts = props?.retryOptions?.maxAttempts ?? 23;
            const backoffRate = props?.retryOptions?.backoffRate ?? 1.3;
            const totalSeconds = interval.toSeconds() * backoffRate ** maxAttempts / (backoffRate - 1);
            if (totalSeconds >= cdk.Duration.days(1).toSeconds()) {
                // https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners#usage-limits
                // "Job queue time - Each job for self-hosted runners can be queued for a maximum of 24 hours. If a self-hosted runner does not start executing the job within this limit, the job is terminated and fails to complete."
                aws_cdk_lib_1.Annotations.of(this).addWarning(`Total retry time is greater than 24 hours (${Math.floor(totalSeconds / 60 / 60)} hours). Jobs expire after 24 hours so it would be a waste of resources to retry further.`);
            }
            runProviders.addRetry({
                interval,
                maxAttempts,
                backoffRate,
                // we retry on everything
                // deleted idle runners will also fail, but the reaper will stop this step function to avoid endless retries
            });
        }
        let logOptions;
        if (this.props?.logOptions) {
            this.stateMachineLogGroup = new aws_cdk_lib_1.aws_logs.LogGroup(this, 'Logs', {
                logGroupName: props?.logOptions?.logGroupName,
                retention: props?.logOptions?.logRetention ?? aws_cdk_lib_1.aws_logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });
            logOptions = {
                destination: this.stateMachineLogGroup,
                includeExecutionData: props?.logOptions?.includeExecutionData ?? true,
                level: props?.logOptions?.level ?? aws_cdk_lib_1.aws_stepfunctions.LogLevel.ALL,
            };
        }
        const stateMachine = new aws_cdk_lib_1.aws_stepfunctions.StateMachine(this, 'Runner Orchestrator', {
            definitionBody: aws_cdk_lib_1.aws_stepfunctions.DefinitionBody.fromChainable(queueIdleReaperTask.next(runProviders)),
            logs: logOptions,
        });
        stateMachine.grantRead(idleReaper);
        stateMachine.grantExecution(idleReaper, 'states:StopExecution');
        for (const provider of this.providers) {
            provider.grantStateMachine(stateMachine);
        }
        return stateMachine;
    }
    tokenRetriever() {
        const func = new token_retriever_function_1.TokenRetrieverFunction(this, 'token-retriever', {
            description: 'Get token from GitHub Actions used to start new self-hosted runner',
            environment: {
                GITHUB_SECRET_ARN: this.secrets.github.secretArn,
                GITHUB_PRIVATE_KEY_SECRET_ARN: this.secrets.githubPrivateKey.secretArn,
                ...this.extraLambdaEnv,
            },
            timeout: cdk.Duration.seconds(30),
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.ORCHESTRATOR),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
            ...this.extraLambdaProps,
        });
        this.secrets.github.grantRead(func);
        this.secrets.githubPrivateKey.grantRead(func);
        return func;
    }
    deleteFailedRunner() {
        const func = new delete_failed_runner_function_1.DeleteFailedRunnerFunction(this, 'delete-runner', {
            description: 'Delete failed GitHub Actions runner on error',
            environment: {
                GITHUB_SECRET_ARN: this.secrets.github.secretArn,
                GITHUB_PRIVATE_KEY_SECRET_ARN: this.secrets.githubPrivateKey.secretArn,
                ...this.extraLambdaEnv,
            },
            timeout: cdk.Duration.seconds(30),
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.ORCHESTRATOR),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
            ...this.extraLambdaProps,
        });
        this.secrets.github.grantRead(func);
        this.secrets.githubPrivateKey.grantRead(func);
        return func;
    }
    statusFunction() {
        const statusFunction = new status_function_1.StatusFunction(this, 'status', {
            description: 'Provide user with status about self-hosted GitHub Actions runners',
            environment: {
                WEBHOOK_SECRET_ARN: this.secrets.webhook.secretArn,
                GITHUB_SECRET_ARN: this.secrets.github.secretArn,
                GITHUB_PRIVATE_KEY_SECRET_ARN: this.secrets.githubPrivateKey.secretArn,
                SETUP_SECRET_ARN: this.secrets.setup.secretArn,
                WEBHOOK_URL: this.webhook.url,
                WEBHOOK_HANDLER_ARN: this.webhook.handler.latestVersion.functionArn,
                STEP_FUNCTION_ARN: this.orchestrator.stateMachineArn,
                STEP_FUNCTION_LOG_GROUP: this.stateMachineLogGroup?.logGroupName ?? '',
                SETUP_FUNCTION_URL: this.setupUrl,
                ...this.extraLambdaEnv,
            },
            timeout: cdk.Duration.minutes(3),
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.SETUP),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
            ...this.extraLambdaProps,
        });
        const providers = this.providers.flatMap(provider => {
            const status = provider.status(statusFunction);
            // Composite providers return an array, regular providers return a single status
            return Array.isArray(status) ? status : [status];
        });
        // expose providers as stack metadata as it's too big for Lambda environment variables
        // specifically integration testing got an error because lambda update request was >5kb
        const stack = cdk.Stack.of(this);
        const f = statusFunction.node.defaultChild;
        f.addPropertyOverride('Environment.Variables.LOGICAL_ID', f.logicalId);
        f.addPropertyOverride('Environment.Variables.STACK_NAME', stack.stackName);
        f.addMetadata('providers', providers);
        statusFunction.addToRolePolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['cloudformation:DescribeStackResource'],
            resources: [stack.stackId],
        }));
        this.secrets.webhook.grantRead(statusFunction);
        this.secrets.github.grantRead(statusFunction);
        this.secrets.githubPrivateKey.grantRead(statusFunction);
        this.secrets.setup.grantRead(statusFunction);
        this.orchestrator.grantRead(statusFunction);
        new cdk.CfnOutput(this, 'status command', {
            value: `aws --region ${stack.region} lambda invoke --function-name ${statusFunction.functionName} status.json`,
        });
        const access = this.props?.statusAccess ?? access_1.LambdaAccess.noAccess();
        const url = access.bind(this, 'status access', statusFunction);
        if (url !== '') {
            new cdk.CfnOutput(this, 'status url', {
                value: url,
            });
        }
    }
    setupFunction() {
        const setupFunction = new setup_function_1.SetupFunction(this, 'setup', {
            description: 'Setup GitHub Actions integration with self-hosted runners',
            environment: {
                SETUP_SECRET_ARN: this.secrets.setup.secretArn,
                WEBHOOK_SECRET_ARN: this.secrets.webhook.secretArn,
                GITHUB_SECRET_ARN: this.secrets.github.secretArn,
                GITHUB_PRIVATE_KEY_SECRET_ARN: this.secrets.githubPrivateKey.secretArn,
                WEBHOOK_URL: this.webhook.url,
                ...this.extraLambdaEnv,
            },
            timeout: cdk.Duration.minutes(3),
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.SETUP),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
            ...this.extraLambdaProps,
        });
        // this.secrets.webhook.grantRead(setupFunction);
        this.secrets.webhook.grantWrite(setupFunction);
        this.secrets.github.grantRead(setupFunction);
        this.secrets.github.grantWrite(setupFunction);
        // this.secrets.githubPrivateKey.grantRead(setupFunction);
        this.secrets.githubPrivateKey.grantWrite(setupFunction);
        this.secrets.setup.grantRead(setupFunction);
        this.secrets.setup.grantWrite(setupFunction);
        const access = this.props?.setupAccess ?? access_1.LambdaAccess.lambdaUrl();
        return access.bind(this, 'setup access', setupFunction);
    }
    checkIntersectingLabels() {
        // this "algorithm" is very inefficient, but good enough for the tiny datasets we expect
        for (const p1 of this.providers) {
            for (const p2 of this.providers) {
                if (p1 == p2) {
                    continue;
                }
                if (p1.labels.every(l => p2.labels.includes(l))) {
                    if (p2.labels.every(l => p1.labels.includes(l))) {
                        throw new Error(`Both ${p1.node.path} and ${p2.node.path} use the same labels [${p1.labels.join(', ')}]`);
                    }
                    aws_cdk_lib_1.Annotations.of(p1).addWarning(`Labels [${p1.labels.join(', ')}] intersect with another provider (${p2.node.path} -- [${p2.labels.join(', ')}]). If a workflow specifies the labels [${p1.labels.join(', ')}], it is not guaranteed which provider will be used. It is recommended you do not use intersecting labels`);
                }
            }
        }
    }
    idleReaper() {
        return new idle_runner_repear_function_1.IdleRunnerRepearFunction(this, 'Idle Reaper', {
            description: 'Stop idle GitHub runners to avoid paying for runners when the job was already canceled',
            environment: {
                GITHUB_SECRET_ARN: this.secrets.github.secretArn,
                GITHUB_PRIVATE_KEY_SECRET_ARN: this.secrets.githubPrivateKey.secretArn,
                ...this.extraLambdaEnv,
            },
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.ORCHESTRATOR),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
            timeout: cdk.Duration.minutes(5),
            ...this.extraLambdaProps,
        });
    }
    idleReaperQueue(reaper) {
        // see this comment to understand why it's a queue that's out of the step function
        // https://github.com/CloudSnorkel/cdk-github-runners/pull/314#issuecomment-1528901192
        const queue = new aws_cdk_lib_1.aws_sqs.Queue(this, 'Idle Reaper Queue', {
            deliveryDelay: cdk.Duration.minutes(10),
            visibilityTimeout: cdk.Duration.minutes(10),
        });
        reaper.addEventSource(new aws_cdk_lib_1.aws_lambda_event_sources.SqsEventSource(queue, {
            reportBatchItemFailures: true,
            maxBatchingWindow: cdk.Duration.minutes(1),
        }));
        this.secrets.github.grantRead(reaper);
        this.secrets.githubPrivateKey.grantRead(reaper);
        return queue;
    }
    lambdaSecurityGroups() {
        if (!this.props?.vpc) {
            if (this.props?.securityGroup) {
                cdk.Annotations.of(this).addWarning('securityGroup is specified, but vpc is not. securityGroup will be ignored');
            }
            if (this.props?.securityGroups) {
                cdk.Annotations.of(this).addWarning('securityGroups is specified, but vpc is not. securityGroups will be ignored');
            }
            return undefined;
        }
        if (this.props.securityGroups) {
            if (this.props.securityGroup) {
                cdk.Annotations.of(this).addWarning('Both securityGroup and securityGroups are specified. securityGroup will be ignored');
            }
            return this.props.securityGroups;
        }
        if (this.props.securityGroup) {
            return [this.props.securityGroup];
        }
        return [new aws_cdk_lib_1.aws_ec2.SecurityGroup(this, 'Management Lambdas Security Group', { vpc: this.props.vpc })];
    }
    /**
     * Extracts all unique IRunnerProvider instances from providers and composite providers (one level only).
     * Uses a Set to ensure we don't process the same provider twice, even if it's used in multiple composites.
     *
     * @returns Set of unique IRunnerProvider instances
     */
    extractUniqueSubProviders() {
        const seen = new Set();
        for (const provider of this.providers) {
            // instanceof doesn't really work in CDK so use this hack instead
            if ('logGroup' in provider) {
                // Regular provider
                seen.add(provider);
            }
            else {
                // Composite provider - access the providers field
                for (const subProvider of provider.providers) {
                    seen.add(subProvider);
                }
            }
        }
        return seen;
    }
    /**
     * Creates a Lambda layer with certificates if extraCertificates is specified.
     */
    createCertificateLayer(scope) {
        if (!this.props?.extraCertificates) {
            return;
        }
        const certificateFiles = (0, utils_1.discoverCertificateFiles)(this.props.extraCertificates);
        // Concatenate all certificates into a single file for NODE_EXTRA_CA_CERTS
        let combinedCertContent = '';
        for (const certFile of certificateFiles) {
            const certContent = fs.readFileSync(certFile, 'utf8');
            combinedCertContent += certContent;
            // Ensure proper PEM format with newline between certificates
            if (!certContent.endsWith('\n')) {
                combinedCertContent += '\n';
            }
        }
        // Create a temporary directory, write the certificate file, create asset, then delete temp dir
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'certificate-layer-'));
        try {
            const certPath = path.join(workdir, 'certs.pem');
            fs.writeFileSync(certPath, combinedCertContent);
            // Set environment variable and create layer
            this.extraLambdaEnv.NODE_EXTRA_CA_CERTS = '/opt/certs.pem';
            this.extraLambdaProps.layers.push(new aws_cdk_lib_1.aws_lambda.LayerVersion(scope, 'Certificate Layer', {
                description: 'Layer containing GitHub Enterprise Server certificate(s) for cdk-github-runners',
                code: aws_cdk_lib_1.aws_lambda.Code.fromAsset(workdir),
            }));
        }
        finally {
            // Calling `fromAsset()` has copied files to the assembly, so we can delete the temporary directory.
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    }
    /**
     * Metric for the number of GitHub Actions jobs completed. It has `ProviderLabels` and `Status` dimensions. The status can be one of "Succeeded", "SucceededWithIssues", "Failed", "Canceled", "Skipped", or "Abandoned".
     *
     * **WARNING:** this method creates a metric filter for each provider. Each metric has a status dimension with six possible values. These resources may incur cost.
     */
    metricJobCompleted(props) {
        if (!this.jobsCompletedMetricFiltersInitialized) {
            // we can't use logs.FilterPattern.spaceDelimited() because it has no support for ||
            // status list taken from https://github.com/actions/runner/blob/be9632302ceef50bfb36ea998cea9c94c75e5d4d/src/Sdk/DTWebApi/WebApi/TaskResult.cs
            // we need "..." for Lambda that prefixes some extra data to log lines
            const pattern = aws_cdk_lib_1.aws_logs.FilterPattern.literal('[..., marker = "CDKGHA", job = "JOB", done = "DONE", labels, status = "Succeeded" || status = "SucceededWithIssues" || status = "Failed" || status = "Canceled" || status = "Skipped" || status = "Abandoned"]');
            // Extract all unique sub-providers from regular and composite providers
            // Build a set first to avoid filtering the same log twice
            for (const p of this.extractUniqueSubProviders()) {
                const metricFilter = p.logGroup.addMetricFilter(`${p.logGroup.node.id} filter`, {
                    metricNamespace: 'GitHubRunners',
                    metricName: 'JobCompleted',
                    filterPattern: pattern,
                    metricValue: '1',
                    // can't with dimensions -- defaultValue: 0,
                    dimensions: {
                        ProviderLabels: '$labels',
                        Status: '$status',
                    },
                });
                if (metricFilter.node.defaultChild instanceof aws_cdk_lib_1.aws_logs.CfnMetricFilter) {
                    metricFilter.node.defaultChild.addPropertyOverride('MetricTransformations.0.Unit', 'Count');
                }
                else {
                    aws_cdk_lib_1.Annotations.of(metricFilter).addWarning('Unable to set metric filter Unit to Count');
                }
            }
            this.jobsCompletedMetricFiltersInitialized = true;
        }
        return new aws_cdk_lib_1.aws_cloudwatch.Metric({
            namespace: 'GitHubRunners',
            metricName: 'JobsCompleted',
            unit: aws_cdk_lib_1.aws_cloudwatch.Unit.COUNT,
            statistic: aws_cdk_lib_1.aws_cloudwatch.Stats.SUM,
            ...props,
        }).attachTo(this);
    }
    /**
     * Metric for successful executions.
     *
     * A successful execution doesn't always mean a runner was started. It can be successful even without any label matches.
     *
     * A successful runner doesn't mean the job it executed was successful. For that, see {@link metricJobCompleted}.
     */
    metricSucceeded(props) {
        return this.orchestrator.metricSucceeded(props);
    }
    /**
     * Metric for failed runner executions.
     *
     * A failed runner usually means the runner failed to start and so a job was never executed. It doesn't necessarily mean the job was executed and failed. For that, see {@link metricJobCompleted}.
     */
    metricFailed(props) {
        return this.orchestrator.metricFailed(props);
    }
    /**
     * Metric for the interval, in milliseconds, between the time the execution starts and the time it closes. This time may be longer than the time the runner took.
     */
    metricTime(props) {
        return this.orchestrator.metricTime(props);
    }
    /**
     * Creates a topic for notifications when a runner image build fails.
     *
     * Runner images are rebuilt every week by default. This provides the latest GitHub Runner version and software updates.
     *
     * If you want to be sure you are using the latest runner version, you can use this topic to be notified when a build fails.
     *
     * When the image builder is defined in a separate stack (e.g. in a split-stacks setup), pass that stack or construct
     * as the optional scope so the topic and failure-notification aspects are created in the same stack as the image
     * builder. Otherwise the aspects may not find the image builder resources.
     *
     * @param scope Optional scope (e.g. the image builder stack) where the topic and aspects will be created. Defaults to this construct.
     */
    failedImageBuildsTopic(scope) {
        scope ?? (scope = this);
        const topic = new aws_cdk_lib_1.aws_sns.Topic(scope, 'Failed Runner Image Builds');
        const stack = cdk.Stack.of(scope);
        cdk.Aspects.of(stack).add(new providers_1.CodeBuildImageBuilderFailedBuildNotifier(topic));
        cdk.Aspects.of(stack).add(new providers_1.AwsImageBuilderFailedBuildNotifier(providers_1.AwsImageBuilderFailedBuildNotifier.createFilteringTopic(scope, topic)));
        return topic;
    }
    /**
     * Creates CloudWatch Logs Insights saved queries that can be used to debug issues with the runners.
     *
     * * "Webhook errors" helps diagnose configuration issues with GitHub integration
     * * "Ignored webhook" helps understand why runners aren't started
     * * "Ignored jobs based on labels" helps debug label matching issues
     * * "Webhook started runners" helps understand which runners were started
     *
     * @param prefix Prefix for the query definitions. Defaults to "GitHub Runners".
     */
    createLogsInsightsQueries(prefix = 'GitHub Runners') {
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Webhook errors', {
            queryDefinitionName: `${prefix}/Webhook errors`,
            logGroups: [this.webhook.handler.logGroup],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                filterStatements: [
                    `strcontains(@logStream, "${this.webhook.handler.functionName}")`,
                    'level = "ERROR"',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Orchestration errors', {
            queryDefinitionName: `${prefix}/Orchestration errors`,
            logGroups: [(0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.ORCHESTRATOR)],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                filterStatements: [
                    'level = "ERROR"',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Runner image build errors', {
            queryDefinitionName: `${prefix}/Runner image build errors`,
            logGroups: [(0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.RUNNER_IMAGE_BUILD)],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                filterStatements: [
                    'strcontains(message, "error") or strcontains(message, "ERROR") or strcontains(message, "Error") or level = "ERROR"',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Ignored webhooks', {
            queryDefinitionName: `${prefix}/Ignored webhooks`,
            logGroups: [this.webhook.handler.logGroup],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                fields: ['@timestamp', 'message.notice'],
                filterStatements: [
                    `strcontains(@logStream, "${this.webhook.handler.functionName}")`,
                    'strcontains(message.notice, "Ignoring")',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Ignored jobs based on labels', {
            queryDefinitionName: `${prefix}/Ignored jobs based on labels`,
            logGroups: [this.webhook.handler.logGroup],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                fields: ['@timestamp', 'message.notice'],
                filterStatements: [
                    `strcontains(@logStream, "${this.webhook.handler.functionName}")`,
                    'strcontains(message.notice, "Ignoring labels")',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Webhook started runners', {
            queryDefinitionName: `${prefix}/Webhook started runners`,
            logGroups: [this.webhook.handler.logGroup],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                fields: ['@timestamp', 'message.sfnInput.jobUrl', 'message.sfnInput.jobLabels', 'message.sfnInput.labels', 'message.sfnInput.provider'],
                filterStatements: [
                    `strcontains(@logStream, "${this.webhook.handler.functionName}")`,
                    'message.sfnInput.jobUrl like /http.*/',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
        new aws_cdk_lib_1.aws_logs.QueryDefinition(this, 'Webhook redeliveries', {
            queryDefinitionName: `${prefix}/Webhook redeliveries`,
            logGroups: [this.redeliverer.handler.logGroup],
            queryString: new aws_cdk_lib_1.aws_logs.QueryString({
                fields: ['@timestamp', 'message.notice', 'message.deliveryId', 'message.guid'],
                filterStatements: [
                    'isPresent(message.deliveryId)',
                ],
                sort: '@timestamp desc',
                limit: 100,
            }),
        });
    }
}
exports.GitHubRunners = GitHubRunners;
_a = JSII_RTTI_SYMBOL_1;
GitHubRunners[_a] = { fqn: "@cloudsnorkel/cdk-github-runners.GitHubRunners", version: "0.0.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVubmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3J1bm5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLHlCQUF5QjtBQUN6Qix5QkFBeUI7QUFDekIsNkJBQTZCO0FBQzdCLG1DQUFtQztBQUNuQyw2Q0FZcUI7QUFDckIsMkNBQXVDO0FBQ3ZDLHFDQUF3QztBQUN4QyxtRkFBNkU7QUFDN0UsK0VBQXlFO0FBQ3pFLDJDQVNxQjtBQUNyQix1Q0FBb0M7QUFDcEMscURBQWlEO0FBQ2pELHVEQUFtRDtBQUNuRCx5RUFBb0U7QUFDcEUsbUNBQXdGO0FBQ3hGLHVDQUFpRDtBQUNqRCw2REFBK0Q7QUEyTS9EOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F1Q0c7QUFDSCxNQUFhLGFBQWMsU0FBUSxzQkFBUztJQTJCMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBVyxLQUEwQjtRQUMzRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRGdDLFVBQUssR0FBTCxLQUFLLENBQXFCO1FBTDVELG1CQUFjLEdBQTRCLEVBQUUsQ0FBQztRQUd0RCwwQ0FBcUMsR0FBRyxLQUFLLENBQUM7UUFLcEQsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLGlCQUFPLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBRTVDLElBQUksQ0FBQyxnQkFBZ0IsR0FBRztZQUN0QixHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHO1lBQ3BCLFVBQVUsRUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLFVBQVU7WUFDbEMsaUJBQWlCLEVBQUUsSUFBSSxDQUFDLEtBQUssRUFBRSxpQkFBaUI7WUFDaEQsY0FBYyxFQUFFLElBQUksQ0FBQyxvQkFBb0IsRUFBRTtZQUMzQyxNQUFNLEVBQUUsRUFBRTtTQUNYLENBQUM7UUFDRixJQUFJLENBQUMsV0FBVyxHQUFHLElBQUkscUJBQUcsQ0FBQyxX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LElBQUksRUFBRSxpQkFBaUI7Z0JBQ3ZCLEtBQUssRUFBRSxHQUFHO2FBQ1gsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILElBQUksc0JBQUksQ0FBQyxlQUFlLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQ3JELG1CQUFtQixFQUFFLEdBQUcsTUFBTSx1QkFBdUI7WUFDckQsU0FBUyxFQUFFLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDO1lBQzlDLFdBQVcsRUFBRSxJQUFJLHNCQUFJLENBQUMsV0FBVyxDQUFDO2dCQUNoQyxNQUFNLEVBQUUsQ0FBQyxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsb0JBQW9CLEVBQUUsY0FBYyxDQUFDO2dCQUM5RSxnQkFBZ0IsRUFBRTtvQkFDaEIsK0JBQStCO2lCQUNoQztnQkFDRCxJQUFJLEVBQUUsaUJBQWlCO2dCQUN2QixLQUFLLEVBQUUsR0FBRzthQUNYLENBQUM7U0FDSCxDQUFDLENBQUM7SUFDTCxDQUFDOztBQWx0Qkgsc0NBbXRCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ29zJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHtcbiAgQW5ub3RhdGlvbnMsXG4gIGF3c19jbG91ZHdhdGNoIGFzIGNsb3Vkd2F0Y2gsXG4gIGF3c19lYzIgYXMgZWMyLFxuICBhd3NfaWFtIGFzIGlhbSxcbiAgYXdzX2xhbWJkYSBhcyBsYW1iZGEsXG4gIGF3c19sYW1iZGFfZXZlbnRfc291cmNlcyBhcyBsYW1iZGFfZXZlbnRfc291cmNlcyxcbiAgYXdzX2xvZ3MgYXMgbG9ncyxcbiAgYXdzX3NucyBhcyBzbnMsXG4gIGF3c19zcXMgYXMgc3FzLFxuICBhd3Nfc3RlcGZ1bmN0aW9ucyBhcyBzdGVwZnVuY3Rpb25zLFxuICBhd3Nfc3RlcGZ1bmN0aW9uc190YXNrcyBhcyBzdGVwZnVuY3Rpb25zX3Rhc2tzLFxufSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IExhbWJkYUFjY2VzcyB9IGZyb20gJy4vYWNjZXNzJztcbmltcG9ydCB7IERlbGV0ZUZhaWxlZFJ1bm5lckZ1bmN0aW9uIH0gZnJvbSAnLi9kZWxldGUtZmFpbGVkLXJ1bm5lci1mdW5jdGlvbic7XG5pbXBvcnQgeyBJZGxlUnVubmVyUmVwZWFyRnVuY3Rpb24gfSBmcm9tICcuL2lkbGUtcnVubmVyLXJlcGVhci1mdW5jdGlvbic7XG5pbXBvcnQge1xuICBBd3NJbWFnZUJ1aWxkZXJGYWlsZWRCdWlsZE5vdGlmaWVyLFxuICBDb2RlQnVpbGRJbWFnZUJ1aWxkZXJGYWlsZWRCdWlsZE5vdGlmaWVyLFxuICBDb2RlQnVpbGRSdW5uZXJQcm92aWRlcixcbiAgRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyLFxuICBJQ29tcG9zaXRlUHJvdmlkZXIsXG4gIElSdW5uZXJQcm92aWRlcixcbiAgTGFtYmRhUnVubmVyUHJvdmlkZXIsXG4gIFByb3ZpZGVyUmV0cnlPcHRpb25zLFxufSBmcm9tICcuL3Byb3ZpZGVycyc7XG5pbXBvcnQgeyBTZWNyZXRzIH0gZnJvbSAnLi9zZWNyZXRzJztcbmltcG9ydCB7IFNldHVwRnVuY3Rpb24gfSBmcm9tICcuL3NldHVwLWZ1bmN0aW9uJztcbmltcG9ydCB7IFN0YXR1c0Z1bmN0aW9uIH0gZnJvbSAnLi9zdGF0dXMtZnVuY3Rpb24nO1xuaW1wb3J0IHsgVG9rZW5SZXRyaWV2ZXJGdW5jdGlvbiB9IGZyb20gJy4vdG9rZW4tcmV0cmlldmVyLWZ1bmN0aW9uJztcbmltcG9ydCB7IGRpc2NvdmVyQ2VydGlmaWNhdGVGaWxlcywgc2luZ2xldG9uTG9nR3JvdXAsIFNpbmdsZXRvbkxvZ1R5cGUgfSBmcm9tICcuL3V0aWxzJztcbmltcG9ydCB7IEdpdGh1YldlYmhvb2tIYW5kbGVyIH0gZnJvbSAnLi93ZWJob29rJztcbmltcG9ydCB7IEdpdGh1YldlYmhvb2tSZWRlbGl2ZXJ5IH0gZnJvbSAnLi93ZWJob29rLXJlZGVsaXZlcnknO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEdpdEh1YlJ1bm5lcnNcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRIdWJSdW5uZXJzUHJvcHMge1xuICAvKipcbiAgICogTGlzdCBvZiBydW5uZXIgcHJvdmlkZXJzIHRvIHVzZS4gQXQgbGVhc3Qgb25lIHByb3ZpZGVyIGlzIHJlcXVpcmVkLiBQcm92aWRlciB3aWxsIGJlIHNlbGVjdGVkIHdoZW4gaXRzIGxhYmVsIG1hdGNoZXMgdGhlIGxhYmVscyByZXF1ZXN0ZWQgYnkgdGhlIHdvcmtmbG93IGpvYi5cbiAgICpcbiAgICogQGRlZmF1bHQgQ29kZUJ1aWxkLCBMYW1iZGEgYW5kIEZhcmdhdGUgcnVubmVycyB3aXRoIGFsbCB0aGUgZGVmYXVsdHMgKG5vIFZQQyBvciBkZWZhdWx0IGFjY291bnQgVlBDKVxuICAgKi9cbiAgcmVhZG9ubHkgcHJvdmlkZXJzPzogKElSdW5uZXJQcm92aWRlciB8IElDb21wb3NpdGVQcm92aWRlcilbXTtcblxuICAvKipcbiAgICogV2hldGhlciB0byByZXF1aXJlIHRoZSBgc2VsZi1ob3N0ZWRgIGxhYmVsLiBJZiBgdHJ1ZWAsIHRoZSBydW5uZXIgd2lsbCBvbmx5IHN0YXJ0IGlmIHRoZSB3b3JrZmxvdyBqb2IgZXhwbGljaXRseSByZXF1ZXN0cyB0aGUgYHNlbGYtaG9zdGVkYCBsYWJlbC5cbiAgICpcbiAgICogQmUgY2FyZWZ1bCB3aGVuIHNldHRpbmcgdGhpcyB0byBgZmFsc2VgLiBBdm9pZCBzZXR0aW5nIHVwIHByb3ZpZGVycyB3aXRoIGdlbmVyaWMgbGFiZWwgcmVxdWlyZW1lbnRzIGxpa2UgYGxpbnV4YCBhcyB0aGV5IG1heSBtYXRjaCB3b3JrZmxvd3MgdGhhdCBhcmUgbm90IG1lYW50IHRvIHJ1biBvbiBzZWxmLWhvc3RlZCBydW5uZXJzLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSByZXF1aXJlU2VsZkhvc3RlZExhYmVsPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVlBDIHVzZWQgZm9yIGFsbCBtYW5hZ2VtZW50IGZ1bmN0aW9ucy4gVXNlIHRoaXMgd2l0aCBHaXRIdWIgRW50ZXJwcmlzZSBTZXJ2ZXIgaG9zdGVkIHRoYXQncyBpbmFjY2Vzc2libGUgZnJvbSBvdXRzaWRlIHRoZSBWUEMuXG4gICAqXG4gICAqICoqTm90ZToqKiBUaGlzIG9ubHkgYWZmZWN0cyBtYW5hZ2VtZW50IGZ1bmN0aW9ucyB0aGF0IGludGVyYWN0IHdpdGggR2l0SHViLiBMYW1iZGEgZnVuY3Rpb25zIHRoYXQgaGVscCB3aXRoIHJ1bm5lciBpbWFnZSBidWlsZGluZyBhbmQgZG9uJ3QgaW50ZXJhY3Qgd2l0aCBHaXRIdWIgYXJlIE5PVCBhZmZlY3RlZCBieSB0aGlzIHNldHRpbmcgYW5kIHdpbGwgcnVuIG91dHNpZGUgdGhlIFZQQy5cbiAgICpcbiAgICogTWFrZSBzdXJlIHRoZSBzZWxlY3RlZCBWUEMgYW5kIHN1Ym5ldHMgaGF2ZSBhY2Nlc3MgdG8gdGhlIGZvbGxvd2luZyB3aXRoIGVpdGhlciBOQVQgR2F0ZXdheSBvciBWUEMgRW5kcG9pbnRzOlxuICAgKiAqIEdpdEh1YiBFbnRlcnByaXNlIFNlcnZlclxuICAgKiAqIFNlY3JldHMgTWFuYWdlclxuICAgKiAqIFNRU1xuICAgKiAqIFN0ZXAgRnVuY3Rpb25zXG4gICAqICogQ2xvdWRGb3JtYXRpb24gKHN0YXR1cyBmdW5jdGlvbiBvbmx5KVxuICAgKiAqIEVDMiAoc3RhdHVzIGZ1bmN0aW9uIG9ubHkpXG4gICAqICogRUNSIChzdGF0dXMgZnVuY3Rpb24gb25seSlcbiAgICovXG4gIHJlYWRvbmx5IHZwYz86IGVjMi5JVnBjO1xuXG4gIC8qKlxuICAgKiBWUEMgc3VibmV0cyB1c2VkIGZvciBhbGwgbWFuYWdlbWVudCBmdW5jdGlvbnMuIFVzZSB0aGlzIHdpdGggR2l0SHViIEVudGVycHJpc2UgU2VydmVyIGhvc3RlZCB0aGF0J3MgaW5hY2Nlc3NpYmxlIGZyb20gb3V0c2lkZSB0aGUgVlBDLlxuICAgKlxuICAgKiAqKk5vdGU6KiogVGhpcyBvbmx5IGFmZmVjdHMgbWFuYWdlbWVudCBmdW5jdGlvbnMgdGhhdCBpbnRlcmFjdCB3aXRoIEdpdEh1Yi4gTGFtYmRhIGZ1bmN0aW9ucyB0aGF0IGhlbHAgd2l0aCBydW5uZXIgaW1hZ2UgYnVpbGRpbmcgYW5kIGRvbid0IGludGVyYWN0IHdpdGggR2l0SHViIGFyZSBOT1QgYWZmZWN0ZWQgYnkgdGhpcyBzZXR0aW5nLlxuICAgKi9cbiAgcmVhZG9ubHkgdnBjU3VibmV0cz86IGVjMi5TdWJuZXRTZWxlY3Rpb247XG5cbiAgLyoqXG4gICAqIEFsbG93IG1hbmFnZW1lbnQgZnVuY3Rpb25zIHRvIHJ1biBpbiBwdWJsaWMgc3VibmV0cy4gTGFtYmRhIEZ1bmN0aW9ucyBpbiBhIHB1YmxpYyBzdWJuZXQgY2FuIE5PVCBhY2Nlc3MgdGhlIGludGVybmV0LlxuICAgKlxuICAgKiAqKk5vdGU6KiogVGhpcyBvbmx5IGFmZmVjdHMgbWFuYWdlbWVudCBmdW5jdGlvbnMgdGhhdCBpbnRlcmFjdCB3aXRoIEdpdEh1Yi4gTGFtYmRhIGZ1bmN0aW9ucyB0aGF0IGhlbHAgd2l0aCBydW5uZXIgaW1hZ2UgYnVpbGRpbmcgYW5kIGRvbid0IGludGVyYWN0IHdpdGggR2l0SHViIGFyZSBOT1QgYWZmZWN0ZWQgYnkgdGhpcyBzZXR0aW5nLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dQdWJsaWNTdWJuZXQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cCBhdHRhY2hlZCB0byBhbGwgbWFuYWdlbWVudCBmdW5jdGlvbnMuIFVzZSB0aGlzIHdpdGggdG8gcHJvdmlkZSBhY2Nlc3MgdG8gR2l0SHViIEVudGVycHJpc2UgU2VydmVyIGhvc3RlZCBpbnNpZGUgYSBWUEMuXG4gICAqXG4gICAqICoqTm90ZToqKiBUaGlzIG9ubHkgYWZmZWN0cyBtYW5hZ2VtZW50IGZ1bmN0aW9ucyB0aGF0IGludGVyYWN0IHdpdGggR2l0SHViLiBMYW1iZGEgZnVuY3Rpb25zIHRoYXQgaGVscCB3aXRoIHJ1bm5lciBpbWFnZSBidWlsZGluZyBhbmQgZG9uJ3QgaW50ZXJhY3Qgd2l0aCBHaXRIdWIgYXJlIE5PVCBhZmZlY3RlZCBieSB0aGlzIHNldHRpbmcuXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIHVzZSB7QGxpbmsgc2VjdXJpdHlHcm91cHN9IGluc3RlYWRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3VyaXR5R3JvdXA/OiBlYzIuSVNlY3VyaXR5R3JvdXA7XG5cbiAgLyoqXG4gICAqIFNlY3VyaXR5IGdyb3VwcyBhdHRhY2hlZCB0byBhbGwgbWFuYWdlbWVudCBmdW5jdGlvbnMuIFVzZSB0aGlzIHRvIHByb3ZpZGUgb3V0Ym91bmQgYWNjZXNzIGZyb20gbWFuYWdlbWVudCBmdW5jdGlvbnMgdG8gR2l0SHViIEVudGVycHJpc2UgU2VydmVyIGhvc3RlZCBpbnNpZGUgYSBWUEMuXG4gICAqXG4gICAqICoqTm90ZToqKiBUaGlzIG9ubHkgYWZmZWN0cyBtYW5hZ2VtZW50IGZ1bmN0aW9ucyB0aGF0IGludGVyYWN0IHdpdGggR2l0SHViLiBMYW1iZGEgZnVuY3Rpb25zIHRoYXQgaGVscCB3aXRoIHJ1bm5lciBpbWFnZSBidWlsZGluZyBhbmQgZG9uJ3QgaW50ZXJhY3Qgd2l0aCBHaXRIdWIgYXJlIE5PVCBhZmZlY3RlZCBieSB0aGlzIHNldHRpbmcuXG4gICAqXG4gICAqICoqTm90ZToqKiBEZWZpbmluZyBpbmJvdW5kIHJ1bGVzIG9uIHRoaXMgc2VjdXJpdHkgZ3JvdXAgZG9lcyBub3RoaW5nLiBUaGlzIHNlY3VyaXR5IGdyb3VwIG9ubHkgY29udHJvbHMgb3V0Ym91bmQgYWNjZXNzIEZST00gdGhlIG1hbmFnZW1lbnQgZnVuY3Rpb25zLiBUbyBsaW1pdCBhY2Nlc3MgVE8gdGhlIHdlYmhvb2sgb3Igc2V0dXAgZnVuY3Rpb25zLCB1c2Uge0BsaW5rIHdlYmhvb2tBY2Nlc3N9IGFuZCB7QGxpbmsgc2V0dXBBY2Nlc3N9IGluc3RlYWQuXG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eUdyb3Vwcz86IGVjMi5JU2VjdXJpdHlHcm91cFtdO1xuXG4gIC8qKlxuICAgKiBQYXRoIHRvIGEgY2VydGlmaWNhdGUgZmlsZSAoLnBlbSBvciAuY3J0KSBvciBhIGRpcmVjdG9yeSBjb250YWluaW5nIGNlcnRpZmljYXRlIGZpbGVzICgucGVtIG9yIC5jcnQpIHJlcXVpcmVkIHRvIHRydXN0IEdpdEh1YiBFbnRlcnByaXNlIFNlcnZlci4gVXNlIHRoaXMgd2hlbiBHaXRIdWIgRW50ZXJwcmlzZSBTZXJ2ZXIgY2VydGlmaWNhdGVzIGFyZSBzZWxmLXNpZ25lZC5cbiAgICpcbiAgICogSWYgYSBkaXJlY3RvcnkgaXMgcHJvdmlkZWQsIGFsbCAucGVtIGFuZCAuY3J0IGZpbGVzIGluIHRoYXQgZGlyZWN0b3J5IHdpbGwgYmUgdXNlZC4gVGhlIGNlcnRpZmljYXRlcyB3aWxsIGJlIGNvbmNhdGVuYXRlZCBpbnRvIGEgc2luZ2xlIGZpbGUgZm9yIHVzZSBieSBOb2RlLmpzLlxuICAgKlxuICAgKiBZb3UgbWF5IGFsc28gd2FudCB0byB1c2UgY3VzdG9tIGltYWdlcyBmb3IgeW91ciBydW5uZXIgcHJvdmlkZXJzIHRoYXQgY29udGFpbiB0aGUgc2FtZSBjZXJ0aWZpY2F0ZXMuIFNlZSB7QGxpbmsgUnVubmVySW1hZ2VDb21wb25lbnQuZXh0cmFDZXJ0aWZpY2F0ZXN9LlxuICAgKlxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIGNvbnN0IHNlbGZTaWduZWRDZXJ0aWZpY2F0ZXMgPSAnY2VydHMvZ2hlcy5wZW0nOyAvLyBvciAncGF0aC10by1teS1leHRyYS1jZXJ0cy1mb2xkZXInIGZvciBhIGRpcmVjdG9yeVxuICAgKiBjb25zdCBpbWFnZUJ1aWxkZXIgPSBDb2RlQnVpbGRSdW5uZXJQcm92aWRlci5pbWFnZUJ1aWxkZXIodGhpcywgJ0ltYWdlIEJ1aWxkZXIgd2l0aCBDZXJ0cycpO1xuICAgKiBpbWFnZUJ1aWxkZXIuYWRkQ29tcG9uZW50KFJ1bm5lckltYWdlQ29tcG9uZW50LmV4dHJhQ2VydGlmaWNhdGVzKHNlbGZTaWduZWRDZXJ0aWZpY2F0ZXMsICdwcml2YXRlLWNhJykpO1xuICAgKlxuICAgKiBjb25zdCBwcm92aWRlciA9IG5ldyBDb2RlQnVpbGRSdW5uZXJQcm92aWRlcih0aGlzLCAnQ29kZUJ1aWxkJywge1xuICAgKiAgICAgaW1hZ2VCdWlsZGVyOiBpbWFnZUJ1aWxkZXIsXG4gICAqIH0pO1xuICAgKlxuICAgKiBuZXcgR2l0SHViUnVubmVycyhcbiAgICogICB0aGlzLFxuICAgKiAgICdydW5uZXJzJyxcbiAgICogICB7XG4gICAqICAgICBwcm92aWRlcnM6IFtwcm92aWRlcl0sXG4gICAqICAgICBleHRyYUNlcnRpZmljYXRlczogc2VsZlNpZ25lZENlcnRpZmljYXRlcyxcbiAgICogICB9XG4gICAqICk7XG4gICAqIGBgYFxuICAgKi9cbiAgcmVhZG9ubHkgZXh0cmFDZXJ0aWZpY2F0ZXM/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRpbWUgdG8gd2FpdCBiZWZvcmUgc3RvcHBpbmcgYSBydW5uZXIgdGhhdCByZW1haW5zIGlkbGUuIElmIHRoZSB1c2VyIGNhbmNlbGxlZCB0aGUgam9iLCBvciBpZiBhbm90aGVyIHJ1bm5lciBzdG9sZSBpdCwgdGhpcyBzdG9wcyB0aGUgcnVubmVyIHRvIGF2b2lkIHdhc3RpbmcgcmVzb3VyY2VzLlxuICAgKlxuICAgKiBAZGVmYXVsdCA1IG1pbnV0ZXNcbiAgICovXG4gIHJlYWRvbmx5IGlkbGVUaW1lb3V0PzogY2RrLkR1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBMb2dnaW5nIG9wdGlvbnMgZm9yIHRoZSBzdGF0ZSBtYWNoaW5lIHRoYXQgbWFuYWdlcyB0aGUgcnVubmVycy5cbiAgICpcbiAgICogQGRlZmF1bHQgbm8gbG9nc1xuICAgKi9cbiAgcmVhZG9ubHkgbG9nT3B0aW9ucz86IExvZ09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEFjY2VzcyBjb25maWd1cmF0aW9uIGZvciB0aGUgc2V0dXAgZnVuY3Rpb24uIE9uY2UgeW91IGZpbmlzaCB0aGUgc2V0dXAgcHJvY2VzcywgeW91IGNhbiBzZXQgdGhpcyB0byBgTGFtYmRhQWNjZXNzLm5vQWNjZXNzKClgIHRvIHJlbW92ZSBhY2Nlc3MgdG8gdGhlIHNldHVwIGZ1bmN0aW9uLiBZb3UgY2FuIGFsc28gdXNlIGBMYW1iZGFBY2Nlc3MuYXBpR2F0ZXdheSh7IGFsbG93ZWRJcHM6IFsnbXktaXAvMCddfSlgIHRvIGxpbWl0IGFjY2VzcyB0byB5b3VyIElQIG9ubHkuXG4gICAqXG4gICAqIEBkZWZhdWx0IExhbWJkYUFjY2Vzcy5sYW1iZGFVcmwoKVxuICAgKi9cbiAgcmVhZG9ubHkgc2V0dXBBY2Nlc3M/OiBMYW1iZGFBY2Nlc3M7XG5cblxuICAvKipcbiAgICogQWNjZXNzIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSB3ZWJob29rIGZ1bmN0aW9uLiBUaGlzIGZ1bmN0aW9uIGlzIGNhbGxlZCBieSBHaXRIdWIgd2hlbiBhIG5ldyB3b3JrZmxvdyBqb2IgaXMgc2NoZWR1bGVkLiBGb3IgYW4gZXh0cmEgbGF5ZXIgb2Ygc2VjdXJpdHksIHlvdSBjYW4gc2V0IHRoaXMgdG8gYExhbWJkYUFjY2Vzcy5hcGlHYXRld2F5KHsgYWxsb3dlZElwczogTGFtYmRhQWNjZXNzLmdpdGh1YldlYmhvb2tJcHMoKSB9KWAuXG4gICAqXG4gICAqIFlvdSBjYW4gYWxzbyBzZXQgdGhpcyB0byBgTGFtYmRhQWNjZXNzLmFwaUdhdGV3YXkoe2FsbG93ZWRWcGM6IHZwYywgYWxsb3dlZElwczogWydHSEVTLklQLkFERFJFU1MvMzInXX0pYCBpZiB5b3VyIEdpdEh1YiBFbnRlcnByaXNlIFNlcnZlciBpcyBob3N0ZWQgaW4gYSBWUEMuIFRoaXMgd2lsbCBjcmVhdGUgYW4gQVBJIEdhdGV3YXkgZW5kcG9pbnQgdGhhdCdzIG9ubHkgYWNjZXNzaWJsZSBmcm9tIHdpdGhpbiB0aGUgVlBDLlxuICAgKlxuICAgKiAqV0FSTklORyo6IGNoYW5naW5nIGFjY2VzcyB0eXBlIG1heSBjaGFuZ2UgdGhlIFVSTC4gV2hlbiB0aGUgVVJMIGNoYW5nZXMsIHlvdSBtdXN0IHVwZGF0ZSBHaXRIdWIgYXMgd2VsbC5cbiAgICpcbiAgICogQGRlZmF1bHQgTGFtYmRhQWNjZXNzLmxhbWJkYVVybCgpXG4gICAqL1xuICByZWFkb25seSB3ZWJob29rQWNjZXNzPzogTGFtYmRhQWNjZXNzO1xuXG4gIC8qKlxuICAgKiBBY2Nlc3MgY29uZmlndXJhdGlvbiBmb3IgdGhlIHN0YXR1cyBmdW5jdGlvbi4gVGhpcyBmdW5jdGlvbiByZXR1cm5zIGEgbG90IG9mIHNlbnNpdGl2ZSBpbmZvcm1hdGlvbiBhYm91dCB0aGUgcnVubmVyLCBzbyB5b3Ugc2hvdWxkIG9ubHkgYWxsb3cgYWNjZXNzIHRvIGl0IGZyb20gdHJ1c3RlZCBJUHMsIGlmIGF0IGFsbC5cbiAgICpcbiAgICogQGRlZmF1bHQgTGFtYmRhQWNjZXNzLm5vQWNjZXNzKClcbiAgICovXG4gIHJlYWRvbmx5IHN0YXR1c0FjY2Vzcz86IExhbWJkYUFjY2VzcztcblxuICAvKipcbiAgICogT3B0aW9ucyB0byByZXRyeSBvcGVyYXRpb24gaW4gY2FzZSBvZiBmYWlsdXJlIGxpa2UgbWlzc2luZyBjYXBhY2l0eSwgb3IgQVBJIHF1b3RhIGlzc3Vlcy5cbiAgICpcbiAgICogR2l0SHViIGpvYnMgdGltZSBvdXQgYWZ0ZXIgbm90IGJlaW5nIGFibGUgdG8gZ2V0IGEgcnVubmVyIGZvciAyNCBob3Vycy4gWW91IHNob3VsZCBub3QgcmV0cnkgZm9yIG1vcmUgdGhhbiAyNCBob3Vycy5cbiAgICpcbiAgICogVG90YWwgdGltZSBzcGVudCB3YWl0aW5nIGNhbiBiZSBjYWxjdWxhdGVkIHdpdGggaW50ZXJ2YWwgKiAoYmFja29mZlJhdGUgXiBtYXhBdHRlbXB0cykgLyAoYmFja29mZlJhdGUgLSAxKS5cbiAgICpcbiAgICogQGRlZmF1bHQgcmV0cnkgMjMgdGltZXMgdXAgdG8gYWJvdXQgMjQgaG91cnNcbiAgICovXG4gIHJlYWRvbmx5IHJldHJ5T3B0aW9ucz86IFByb3ZpZGVyUmV0cnlPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBMYW1iZGEgZnVuY3Rpb24gdG8gY3VzdG9taXplIHByb3ZpZGVyIHNlbGVjdGlvbiBsb2dpYyBhbmQgbGFiZWwgYXNzaWdubWVudC5cbiAgICpcbiAgICogKiBUaGUgZnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHdlYmhvb2sgcGF5bG9hZCBhbG9uZyB3aXRoIGRlZmF1bHQgcHJvdmlkZXIgYW5kIGl0cyBsYWJlbHMgYXMge0BsaW5rIFByb3ZpZGVyU2VsZWN0b3JJbnB1dH1cbiAgICogKiBUaGUgZnVuY3Rpb24gcmV0dXJucyBhIHNlbGVjdGVkIHByb3ZpZGVyIGFuZCBpdHMgbGFiZWxzIGFzIHtAbGluayBQcm92aWRlclNlbGVjdG9yUmVzdWx0fVxuICAgKiAqIFlvdSBjYW4gZGVjbGluZSB0byBwcm92aXNpb24gYSBydW5uZXIgYnkgcmV0dXJuaW5nIHVuZGVmaW5lZCBhcyB0aGUgcHJvdmlkZXIgc2VsZWN0b3IgcmVzdWx0XG4gICAqICogWW91IGNhbiBmdWxseSBjdXN0b21pemUgdGhlIGxhYmVscyBmb3IgdGhlIGFib3V0LXRvLWJlLXByb3Zpc2lvbmVkIHJ1bm5lciAoYWRkLCByZW1vdmUsIG1vZGlmeSwgZHluYW1pYyBsYWJlbHMsIGV0Yy4pXG4gICAqICogTGFiZWxzIGRvbid0IGhhdmUgdG8gbWF0Y2ggdGhlIGxhYmVscyBvcmlnaW5hbGx5IGNvbmZpZ3VyZWQgZm9yIHRoZSBwcm92aWRlciwgYnV0IHNlZSB3YXJuaW5ncyBiZWxvd1xuICAgKiAqIFRoaXMgZnVuY3Rpb24gd2lsbCBiZSBjYWxsZWQgc3luY2hyb25vdXNseSBkdXJpbmcgd2ViaG9vayBwcm9jZXNzaW5nLCBzbyBpdCBzaG91bGQgYmUgZmFzdCBhbmQgZWZmaWNpZW50ICh3ZWJob29rIGxpbWl0IGlzIDMwIHNlY29uZHMgdG90YWwpXG4gICAqXG4gICAqICoqV0FSTklORzogSXQgaXMgeW91ciByZXNwb25zaWJpbGl0eSB0byBlbnN1cmUgdGhlIHNlbGVjdGVkIHByb3ZpZGVyJ3MgbGFiZWxzIG1hdGNoIHRoZSBqb2IncyByZXF1aXJlZCBsYWJlbHMuIElmIHlvdSByZXR1cm4gdGhlIHdyb25nIGxhYmVscywgdGhlIHJ1bm5lciB3aWxsIGJlIGNyZWF0ZWQgYnV0IEdpdEh1YiBBY3Rpb25zIHdpbGwgbm90IGFzc2lnbiB0aGUgam9iIHRvIGl0LioqXG4gICAqXG4gICAqICoqV0FSTklORzogUHJvdmlkZXIgc2VsZWN0aW9uIGlzIG5vdCBhIGd1YXJhbnRlZSB0aGF0IGEgc3BlY2lmaWMgcHJvdmlkZXIgd2lsbCBiZSBhc3NpZ25lZCBmb3IgdGhlIGpvYi4gR2l0SHViIEFjdGlvbnMgbWF5IGFzc2lnbiB0aGUgam9iIHRvIGFueSBydW5uZXIgd2l0aCBtYXRjaGluZyBsYWJlbHMuIFRoZSBwcm92aWRlciBzZWxlY3RvciBvbmx5IGRldGVybWluZXMgd2hpY2ggcHJvdmlkZXIncyBydW5uZXIgd2lsbCBiZSAqY3JlYXRlZCosIGJ1dCBHaXRIdWIgQWN0aW9ucyBtYXkgcm91dGUgdGhlIGpvYiB0byBhbnkgYXZhaWxhYmxlIHJ1bm5lciB3aXRoIHRoZSByZXF1aXJlZCBsYWJlbHMuKipcbiAgICpcbiAgICogKipGb3IgcmVsaWFibGUgcHJvdmlkZXIgYXNzaWdubWVudCBiYXNlZCBvbiBqb2IgY2hhcmFjdGVyaXN0aWNzLCBjb25zaWRlciB1c2luZyByZXBvLWxldmVsIHJ1bm5lciByZWdpc3RyYXRpb24gd2hlcmUgeW91IGNhbiBjb250cm9sIHdoaWNoIHJ1bm5lcnMgYXJlIGF2YWlsYWJsZSBmb3Igc3BlY2lmaWMgcmVwb3NpdG9yaWVzLiBTZWUge0BsaW5rIFNFVFVQX0dJVEhVQi5tZH0gZm9yIG1vcmUgZGV0YWlscyBvbiB0aGUgZGlmZmVyZW50IHJlZ2lzdHJhdGlvbiBsZXZlbHMuIFRoaXMgaW5mb3JtYXRpb24gaXMgYWxzbyBhdmFpbGFibGUgd2hpbGUgdXNpbmcgdGhlIHNldHVwIHdpemFyZC5cbiAgICovXG4gIHJlYWRvbmx5IHByb3ZpZGVyU2VsZWN0b3I/OiBsYW1iZGEuSUZ1bmN0aW9uO1xufVxuXG4vKipcbiAqIERlZmluZXMgd2hhdCBleGVjdXRpb24gaGlzdG9yeSBldmVudHMgYXJlIGxvZ2dlZCBhbmQgd2hlcmUgdGhleSBhcmUgbG9nZ2VkLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIExvZ09wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGxvZyBncm91cCB3aGVyZSB0aGUgZXhlY3V0aW9uIGhpc3RvcnkgZXZlbnRzIHdpbGwgYmUgbG9nZ2VkLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXBOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBEZXRlcm1pbmVzIHdoZXRoZXIgZXhlY3V0aW9uIGRhdGEgaXMgaW5jbHVkZWQgaW4geW91ciBsb2cuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBpbmNsdWRlRXhlY3V0aW9uRGF0YT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERlZmluZXMgd2hpY2ggY2F0ZWdvcnkgb2YgZXhlY3V0aW9uIGhpc3RvcnkgZXZlbnRzIGFyZSBsb2dnZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IEVSUk9SXG4gICAqL1xuICByZWFkb25seSBsZXZlbD86IHN0ZXBmdW5jdGlvbnMuTG9nTGV2ZWw7XG5cbiAgLyoqXG4gICAqIFRoZSBudW1iZXIgb2YgZGF5cyBsb2cgZXZlbnRzIGFyZSBrZXB0IGluIENsb3VkV2F0Y2ggTG9ncy4gV2hlbiB1cGRhdGluZ1xuICAgKiB0aGlzIHByb3BlcnR5LCB1bnNldHRpbmcgaXQgZG9lc24ndCByZW1vdmUgdGhlIGxvZyByZXRlbnRpb24gcG9saWN5LiBUb1xuICAgKiByZW1vdmUgdGhlIHJldGVudGlvbiBwb2xpY3ksIHNldCB0aGUgdmFsdWUgdG8gYElORklOSVRFYC5cbiAgICpcbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgbG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhbGwgdGhlIHJlcXVpcmVkIGluZnJhc3RydWN0dXJlIHRvIHByb3ZpZGUgc2VsZi1ob3N0ZWQgR2l0SHViIHJ1bm5lcnMuIEl0IGNyZWF0ZXMgYSB3ZWJob29rLCBzZWNyZXRzLCBhbmQgYSBzdGVwIGZ1bmN0aW9uIHRvIG9yY2hlc3RyYXRlIGFsbCBydW5zLiBTZWNyZXRzIGFyZSBub3QgYXV0b21hdGljYWxseSBmaWxsZWQuIFNlZSBSRUFETUUubWQgZm9yIGluc3RydWN0aW9ucyBvbiBob3cgdG8gc2V0dXAgR2l0SHViIGludGVncmF0aW9uLlxuICpcbiAqIEJ5IGRlZmF1bHQsIHRoaXMgd2lsbCBjcmVhdGUgYSBydW5uZXIgcHJvdmlkZXIgb2YgZWFjaCBhdmFpbGFibGUgdHlwZSB3aXRoIHRoZSBkZWZhdWx0cy4gVGhpcyBpcyBnb29kIGVub3VnaCBmb3IgdGhlIGluaXRpYWwgc2V0dXAgc3RhZ2Ugd2hlbiB5b3UganVzdCB3YW50IHRvIGdldCBHaXRIdWIgaW50ZWdyYXRpb24gd29ya2luZy5cbiAqXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBuZXcgR2l0SHViUnVubmVycyh0aGlzLCAncnVubmVycycpO1xuICogYGBgXG4gKlxuICogVXN1YWxseSB5b3UnZCB3YW50IHRvIGNvbmZpZ3VyZSB0aGUgcnVubmVyIHByb3ZpZGVycyBzbyB0aGUgcnVubmVycyBjYW4gcnVuIGluIGEgY2VydGFpbiBWUEMgb3IgaGF2ZSBjZXJ0YWluIHBlcm1pc3Npb25zLlxuICpcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbUxvb2t1cCh0aGlzLCAndnBjJywgeyB2cGNJZDogJ3ZwYy0xMjM0NTY3JyB9KTtcbiAqIGNvbnN0IHJ1bm5lclNnID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdydW5uZXIgc2VjdXJpdHkgZ3JvdXAnLCB7IHZwYzogdnBjIH0pO1xuICogY29uc3QgZGJTZyA9IGVjMi5TZWN1cml0eUdyb3VwLmZyb21TZWN1cml0eUdyb3VwSWQodGhpcywgJ2RhdGFiYXNlIHNlY3VyaXR5IGdyb3VwJywgJ3NnLTEyMzQ1NjcnKTtcbiAqIGNvbnN0IGJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ3J1bm5lciBidWNrZXQnKTtcbiAqXG4gKiAvLyBjcmVhdGUgYSBjdXN0b20gQ29kZUJ1aWxkIHByb3ZpZGVyXG4gKiBjb25zdCBteVByb3ZpZGVyID0gbmV3IENvZGVCdWlsZFJ1bm5lclByb3ZpZGVyKFxuICogICB0aGlzLCAnY29kZWJ1aWxkIHJ1bm5lcicsXG4gKiAgIHtcbiAqICAgICAgbGFiZWxzOiBbJ215LWNvZGVidWlsZCddLFxuICogICAgICB2cGM6IHZwYyxcbiAqICAgICAgc2VjdXJpdHlHcm91cHM6IFtydW5uZXJTZ10sXG4gKiAgIH0sXG4gKiApO1xuICogLy8gZ3JhbnQgc29tZSBwZXJtaXNzaW9ucyB0byB0aGUgcHJvdmlkZXJcbiAqIGJ1Y2tldC5ncmFudFJlYWRXcml0ZShteVByb3ZpZGVyKTtcbiAqIGRiU2cuY29ubmVjdGlvbnMuYWxsb3dGcm9tKHJ1bm5lclNnLCBlYzIuUG9ydC50Y3AoMzMwNiksICdhbGxvdyBydW5uZXJzIHRvIGNvbm5lY3QgdG8gTXlTUUwgZGF0YWJhc2UnKTtcbiAqXG4gKiAvLyBjcmVhdGUgdGhlIHJ1bm5lciBpbmZyYXN0cnVjdHVyZVxuICogbmV3IEdpdEh1YlJ1bm5lcnMoXG4gKiAgIHRoaXMsXG4gKiAgICdydW5uZXJzJyxcbiAqICAge1xuICogICAgIHByb3ZpZGVyczogW215UHJvdmlkZXJdLFxuICogICB9XG4gKiApO1xuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBHaXRIdWJSdW5uZXJzIGV4dGVuZHMgQ29uc3RydWN0IGltcGxlbWVudHMgZWMyLklDb25uZWN0YWJsZSB7XG4gIC8qKlxuICAgKiBDb25maWd1cmVkIHJ1bm5lciBwcm92aWRlcnMuXG4gICAqL1xuICByZWFkb25seSBwcm92aWRlcnM6IChJUnVubmVyUHJvdmlkZXIgfCBJQ29tcG9zaXRlUHJvdmlkZXIpW107XG5cbiAgLyoqXG4gICAqIFNlY3JldHMgZm9yIEdpdEh1YiBjb21tdW5pY2F0aW9uIGluY2x1ZGluZyB3ZWJob29rIHNlY3JldCBhbmQgcnVubmVyIGF1dGhlbnRpY2F0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0czogU2VjcmV0cztcblxuICAvKipcbiAgICogTWFuYWdlIHRoZSBjb25uZWN0aW9ucyBvZiBhbGwgbWFuYWdlbWVudCBmdW5jdGlvbnMuIFVzZSB0aGlzIHRvIGVuYWJsZSBjb25uZWN0aW9ucyB0byB5b3VyIEdpdEh1YiBFbnRlcnByaXNlIFNlcnZlciBpbiBhIFZQQy5cbiAgICpcbiAgICogVGhpcyBjYW5ub3QgYmUgdXNlZCB0byBtYW5hZ2UgY29ubmVjdGlvbnMgb2YgdGhlIHJ1bm5lcnMuIFVzZSB0aGUgYGNvbm5lY3Rpb25zYCBwcm9wZXJ0eSBvZiBlYWNoIHJ1bm5lciBwcm92aWRlciB0byBtYW5hZ2UgcnVubmVyIGNvbm5lY3Rpb25zLlxuICAgKi9cbiAgcmVhZG9ubHkgY29ubmVjdGlvbnM6IGVjMi5Db25uZWN0aW9ucztcblxuICBwcml2YXRlIHJlYWRvbmx5IHdlYmhvb2s6IEdpdGh1YldlYmhvb2tIYW5kbGVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlZGVsaXZlcmVyOiBHaXRodWJXZWJob29rUmVkZWxpdmVyeTtcbiAgcHJpdmF0ZSByZWFkb25seSBvcmNoZXN0cmF0b3I6IHN0ZXBmdW5jdGlvbnMuU3RhdGVNYWNoaW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHNldHVwVXJsOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgZXh0cmFMYW1iZGFFbnY6IHsgW3A6IHN0cmluZ106IHN0cmluZyB9ID0ge307XG4gIHByaXZhdGUgcmVhZG9ubHkgZXh0cmFMYW1iZGFQcm9wczogbGFtYmRhLkZ1bmN0aW9uT3B0aW9ucztcbiAgcHJpdmF0ZSBzdGF0ZU1hY2hpbmVMb2dHcm91cD86IGxvZ3MuTG9nR3JvdXA7XG4gIHByaXZhdGUgam9ic0NvbXBsZXRlZE1ldHJpY0ZpbHRlcnNJbml0aWFsaXplZCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHJlYWRvbmx5IHByb3BzPzogR2l0SHViUnVubmVyc1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMuc2VjcmV0cyA9IG5ldyBTZWNyZXRzKHRoaXMsICdTZWNyZXRzJyk7XG5cbiAgICB0aGlzLmV4dHJhTGFtYmRhUHJvcHMgPSB7XG4gICAgICB2cGM6IHRoaXMucHJvcHM/LnZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHRoaXMucHJvcHM/LnZwY1N1Ym5ldHMsXG4gICAgICBhbGxvd1B1YmxpY1N1Ym5ldDogdGhpcy5wcm9wcz8uYWxsb3dQdWJsaWNTdWJuZXQsXG4gICAgICBzZWN1cml0eUdyb3VwczogdGhpcy5sYW1iZGFTZWN1cml0eUdyb3VwcygpLFxuICAgICAgbGF5ZXJzOiBbXSxcbiAgICB9O1xuICAgIHRoaXMuY29ubmVjdGlvbnMgPSBuZXcgZWMyLkNvbm5lY3Rpb25zKHsgc2VjdXJpdHlHcm91cHM6IHRoaXMuZXh0cmFMYW1iZGFQcm9wcy5zZWN1cml0eUdyb3VwcyB9KTtcblxuICAgIHRoaXMuY3JlYXRlQ2VydGlmaWNhdGVMYXllcihzY29wZSk7XG5cbiAgICBpZiAodGhpcy5wcm9wcz8ucHJvdmlkZXJzKSB7XG4gICAgICB0aGlzLnByb3ZpZGVycyA9IHRoaXMucHJvcHMucHJvdmlkZXJzO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnByb3ZpZGVycyA9IFtcbiAgICAgICAgbmV3IENvZGVCdWlsZFJ1bm5lclByb3ZpZGVyKHRoaXMsICdDb2RlQnVpbGQnKSxcbiAgICAgICAgbmV3IExhbWJkYVJ1bm5lclByb3ZpZGVyKHRoaXMsICdMYW1iZGEnKSxcbiAgICAgICAgbmV3IEZhcmdhdGVSdW5uZXJQcm92aWRlcih0aGlzLCAnRmFyZ2F0ZScpLFxuICAgICAgXTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5wcm92aWRlcnMubGVuZ3RoID09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQXQgbGVhc3Qgb25lIHJ1bm5lciBwcm92aWRlciBpcyByZXF1aXJlZCcpO1xuICAgIH1cblxuICAgIHRoaXMuY2hlY2tJbnRlcnNlY3RpbmdMYWJlbHMoKTtcblxuICAgIHRoaXMub3JjaGVzdHJhdG9yID0gdGhpcy5zdGF0ZU1hY2hpbmUocHJvcHMpO1xuICAgIHRoaXMud2ViaG9vayA9IG5ldyBHaXRodWJXZWJob29rSGFuZGxlcih0aGlzLCAnV2ViaG9vayBIYW5kbGVyJywge1xuICAgICAgb3JjaGVzdHJhdG9yOiB0aGlzLm9yY2hlc3RyYXRvcixcbiAgICAgIHNlY3JldHM6IHRoaXMuc2VjcmV0cyxcbiAgICAgIGFjY2VzczogdGhpcy5wcm9wcz8ud2ViaG9va0FjY2VzcyA/PyBMYW1iZGFBY2Nlc3MubGFtYmRhVXJsKCksXG4gICAgICBwcm92aWRlcnM6IHRoaXMucHJvdmlkZXJzLnJlZHVjZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4+KChhY2MsIHApID0+IHtcbiAgICAgICAgYWNjW3Aubm9kZS5wYXRoXSA9IHAubGFiZWxzO1xuICAgICAgICByZXR1cm4gYWNjO1xuICAgICAgfSwge30pLFxuICAgICAgcmVxdWlyZVNlbGZIb3N0ZWRMYWJlbDogdGhpcy5wcm9wcz8ucmVxdWlyZVNlbGZIb3N0ZWRMYWJlbCA/PyB0cnVlLFxuICAgICAgcHJvdmlkZXJTZWxlY3RvcjogdGhpcy5wcm9wcz8ucHJvdmlkZXJTZWxlY3RvcixcbiAgICAgIGV4dHJhTGFtYmRhUHJvcHM6IHRoaXMuZXh0cmFMYW1iZGFQcm9wcyxcbiAgICAgIGV4dHJhTGFtYmRhRW52OiB0aGlzLmV4dHJhTGFtYmRhRW52LFxuICAgIH0pO1xuICAgIHRoaXMucmVkZWxpdmVyZXIgPSBuZXcgR2l0aHViV2ViaG9va1JlZGVsaXZlcnkodGhpcywgJ1dlYmhvb2sgUmVkZWxpdmVyeScsIHtcbiAgICAgIHNlY3JldHM6IHRoaXMuc2VjcmV0cyxcbiAgICAgIGV4dHJhTGFtYmRhUHJvcHM6IHRoaXMuZXh0cmFMYW1iZGFQcm9wcyxcbiAgICAgIGV4dHJhTGFtYmRhRW52OiB0aGlzLmV4dHJhTGFtYmRhRW52LFxuICAgIH0pO1xuXG4gICAgdGhpcy5zZXR1cFVybCA9IHRoaXMuc2V0dXBGdW5jdGlvbigpO1xuICAgIHRoaXMuc3RhdHVzRnVuY3Rpb24oKTtcbiAgfVxuXG4gIHByaXZhdGUgc3RhdGVNYWNoaW5lKHByb3BzPzogR2l0SHViUnVubmVyc1Byb3BzKSB7XG4gICAgY29uc3QgdG9rZW5SZXRyaWV2ZXJUYXNrID0gbmV3IHN0ZXBmdW5jdGlvbnNfdGFza3MuTGFtYmRhSW52b2tlKFxuICAgICAgdGhpcyxcbiAgICAgICdHZXQgUnVubmVyIFRva2VuJyxcbiAgICAgIHtcbiAgICAgICAgbGFtYmRhRnVuY3Rpb246IHRoaXMudG9rZW5SZXRyaWV2ZXIoKSxcbiAgICAgICAgcGF5bG9hZFJlc3BvbnNlT25seTogdHJ1ZSxcbiAgICAgICAgcmVzdWx0UGF0aDogJyQucnVubmVyJyxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGxldCBkZWxldGVGYWlsZWRSdW5uZXJGdW5jdGlvbiA9IHRoaXMuZGVsZXRlRmFpbGVkUnVubmVyKCk7XG4gICAgY29uc3QgZGVsZXRlRmFpbGVkUnVubmVyVGFzayA9IG5ldyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkxhbWJkYUludm9rZShcbiAgICAgIHRoaXMsXG4gICAgICAnRGVsZXRlIEZhaWxlZCBSdW5uZXInLFxuICAgICAge1xuICAgICAgICBsYW1iZGFGdW5jdGlvbjogZGVsZXRlRmFpbGVkUnVubmVyRnVuY3Rpb24sXG4gICAgICAgIHBheWxvYWRSZXNwb25zZU9ubHk6IHRydWUsXG4gICAgICAgIHJlc3VsdFBhdGg6ICckLmRlbGV0ZScsXG4gICAgICAgIHBheWxvYWQ6IHN0ZXBmdW5jdGlvbnMuVGFza0lucHV0LmZyb21PYmplY3Qoe1xuICAgICAgICAgIHJ1bm5lck5hbWU6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQkLkV4ZWN1dGlvbi5OYW1lJyksXG4gICAgICAgICAgb3duZXI6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQub3duZXInKSxcbiAgICAgICAgICByZXBvOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLnN0cmluZ0F0KCckLnJlcG8nKSxcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZDogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5udW1iZXJBdCgnJC5pbnN0YWxsYXRpb25JZCcpLFxuICAgICAgICAgIGVycm9yOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLm9iamVjdEF0KCckLmVycm9yJyksXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICApO1xuICAgIGRlbGV0ZUZhaWxlZFJ1bm5lclRhc2suYWRkUmV0cnkoe1xuICAgICAgZXJyb3JzOiBbXG4gICAgICAgICdSdW5uZXJCdXN5JyxcbiAgICAgIF0sXG4gICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgICBiYWNrb2ZmUmF0ZTogMSxcbiAgICAgIG1heEF0dGVtcHRzOiA2MCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGlkbGVSZWFwZXIgPSB0aGlzLmlkbGVSZWFwZXIoKTtcbiAgICBjb25zdCBxdWV1ZUlkbGVSZWFwZXJUYXNrID0gbmV3IHN0ZXBmdW5jdGlvbnNfdGFza3MuU3FzU2VuZE1lc3NhZ2UodGhpcywgJ1F1ZXVlIElkbGUgUmVhcGVyJywge1xuICAgICAgcXVldWU6IHRoaXMuaWRsZVJlYXBlclF1ZXVlKGlkbGVSZWFwZXIpLFxuICAgICAgbWVzc2FnZUJvZHk6IHN0ZXBmdW5jdGlvbnMuVGFza0lucHV0LmZyb21PYmplY3Qoe1xuICAgICAgICBleGVjdXRpb25Bcm46IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQkLkV4ZWN1dGlvbi5JZCcpLFxuICAgICAgICBydW5uZXJOYW1lOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLnN0cmluZ0F0KCckJC5FeGVjdXRpb24uTmFtZScpLFxuICAgICAgICBvd25lcjogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5zdHJpbmdBdCgnJC5vd25lcicpLFxuICAgICAgICByZXBvOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLnN0cmluZ0F0KCckLnJlcG8nKSxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGgubnVtYmVyQXQoJyQuaW5zdGFsbGF0aW9uSWQnKSxcbiAgICAgICAgbWF4SWRsZVNlY29uZHM6IChwcm9wcz8uaWRsZVRpbWVvdXQgPz8gY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSkpLnRvU2Vjb25kcygpLFxuICAgICAgfSksXG4gICAgICByZXN1bHRQYXRoOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLkRJU0NBUkQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBwcm92aWRlckNob29zZXIgPSBuZXcgc3RlcGZ1bmN0aW9ucy5DaG9pY2UodGhpcywgJ0Nob29zZSBwcm92aWRlcicpO1xuICAgIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgdGhpcy5wcm92aWRlcnMpIHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyVGFzayA9IHByb3ZpZGVyLmdldFN0ZXBGdW5jdGlvblRhc2soXG4gICAgICAgIHtcbiAgICAgICAgICBydW5uZXJUb2tlblBhdGg6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQucnVubmVyLnRva2VuJyksXG4gICAgICAgICAgcnVubmVyTmFtZVBhdGg6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQkLkV4ZWN1dGlvbi5OYW1lJyksXG4gICAgICAgICAgZ2l0aHViRG9tYWluUGF0aDogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5zdHJpbmdBdCgnJC5ydW5uZXIuZG9tYWluJyksXG4gICAgICAgICAgb3duZXJQYXRoOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLnN0cmluZ0F0KCckLm93bmVyJyksXG4gICAgICAgICAgcmVwb1BhdGg6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQucmVwbycpLFxuICAgICAgICAgIHJlZ2lzdHJhdGlvblVybDogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5zdHJpbmdBdCgnJC5ydW5uZXIucmVnaXN0cmF0aW9uVXJsJyksXG4gICAgICAgICAgbGFiZWxzUGF0aDogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5zdHJpbmdBdCgnJC5sYWJlbHMnKSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgICBwcm92aWRlckNob29zZXIud2hlbihcbiAgICAgICAgc3RlcGZ1bmN0aW9ucy5Db25kaXRpb24uYW5kKFxuICAgICAgICAgIHN0ZXBmdW5jdGlvbnMuQ29uZGl0aW9uLnN0cmluZ0VxdWFscygnJC5wcm92aWRlcicsIHByb3ZpZGVyLm5vZGUucGF0aCksXG4gICAgICAgICksXG4gICAgICAgIHByb3ZpZGVyVGFzayxcbiAgICAgICAge1xuICAgICAgICAgIGNvbW1lbnQ6IGBMYWJlbHM6ICR7cHJvdmlkZXIubGFiZWxzLmpvaW4oJywgJyl9YCxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcHJvdmlkZXJDaG9vc2VyLm90aGVyd2lzZShuZXcgc3RlcGZ1bmN0aW9ucy5TdWNjZWVkKHRoaXMsICdVbmtub3duIGxhYmVsJykpO1xuXG4gICAgY29uc3QgcnVuUHJvdmlkZXJzID0gbmV3IHN0ZXBmdW5jdGlvbnMuUGFyYWxsZWwodGhpcywgJ1J1biBQcm92aWRlcnMnKS5icmFuY2goXG4gICAgICBuZXcgc3RlcGZ1bmN0aW9ucy5QYXJhbGxlbCh0aGlzLCAnRXJyb3IgSGFuZGxlcicpLmJyYW5jaChcbiAgICAgICAgLy8gd2UgZ2V0IGEgdG9rZW4gZm9yIGV2ZXJ5IHJldHJ5IGJlY2F1c2UgdGhlIHRva2VuIGNhbiBleHBpcmUgZmFzdGVyIHRoYW4gdGhlIGpvYiBjYW4gdGltZW91dFxuICAgICAgICB0b2tlblJldHJpZXZlclRhc2submV4dChwcm92aWRlckNob29zZXIpLFxuICAgICAgKS5hZGRDYXRjaChcbiAgICAgICAgLy8gZGVsZXRlIHJ1bm5lciBvbiBmYWlsdXJlIGFzIGl0IHdvbid0IHJlbW92ZSBpdHNlbGYgYW5kIHRoZXJlIGlzIGEgbGltaXQgb24gdGhlIG51bWJlciBvZiByZWdpc3RlcmVkIHJ1bm5lcnNcbiAgICAgICAgZGVsZXRlRmFpbGVkUnVubmVyVGFzayxcbiAgICAgICAge1xuICAgICAgICAgIHJlc3VsdFBhdGg6ICckLmVycm9yJyxcbiAgICAgICAgfSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIGlmIChwcm9wcz8ucmV0cnlPcHRpb25zPy5yZXRyeSA/PyB0cnVlKSB7XG4gICAgICBjb25zdCBpbnRlcnZhbCA9IHByb3BzPy5yZXRyeU9wdGlvbnM/LmludGVydmFsID8/IGNkay5EdXJhdGlvbi5taW51dGVzKDEpO1xuICAgICAgY29uc3QgbWF4QXR0ZW1wdHMgPSBwcm9wcz8ucmV0cnlPcHRpb25zPy5tYXhBdHRlbXB0cyA/PyAyMztcbiAgICAgIGNvbnN0IGJhY2tvZmZSYXRlID0gcHJvcHM/LnJldHJ5T3B0aW9ucz8uYmFja29mZlJhdGUgPz8gMS4zO1xuXG4gICAgICBjb25zdCB0b3RhbFNlY29uZHMgPSBpbnRlcnZhbC50b1NlY29uZHMoKSAqIGJhY2tvZmZSYXRlICoqIG1heEF0dGVtcHRzIC8gKGJhY2tvZmZSYXRlIC0gMSk7XG4gICAgICBpZiAodG90YWxTZWNvbmRzID49IGNkay5EdXJhdGlvbi5kYXlzKDEpLnRvU2Vjb25kcygpKSB7XG4gICAgICAgIC8vIGh0dHBzOi8vZG9jcy5naXRodWIuY29tL2VuL2FjdGlvbnMvaG9zdGluZy15b3VyLW93bi1ydW5uZXJzL21hbmFnaW5nLXNlbGYtaG9zdGVkLXJ1bm5lcnMvYWJvdXQtc2VsZi1ob3N0ZWQtcnVubmVycyN1c2FnZS1saW1pdHNcbiAgICAgICAgLy8gXCJKb2IgcXVldWUgdGltZSAtIEVhY2ggam9iIGZvciBzZWxmLWhvc3RlZCBydW5uZXJzIGNhbiBiZSBxdWV1ZWQgZm9yIGEgbWF4aW11bSBvZiAyNCBob3Vycy4gSWYgYSBzZWxmLWhvc3RlZCBydW5uZXIgZG9lcyBub3Qgc3RhcnQgZXhlY3V0aW5nIHRoZSBqb2Igd2l0aGluIHRoaXMgbGltaXQsIHRoZSBqb2IgaXMgdGVybWluYXRlZCBhbmQgZmFpbHMgdG8gY29tcGxldGUuXCJcbiAgICAgICAgQW5ub3RhdGlvbnMub2YodGhpcykuYWRkV2FybmluZyhgVG90YWwgcmV0cnkgdGltZSBpcyBncmVhdGVyIHRoYW4gMjQgaG91cnMgKCR7TWF0aC5mbG9vcih0b3RhbFNlY29uZHMgLyA2MCAvIDYwKX0gaG91cnMpLiBKb2JzIGV4cGlyZSBhZnRlciAyNCBob3VycyBzbyBpdCB3b3VsZCBiZSBhIHdhc3RlIG9mIHJlc291cmNlcyB0byByZXRyeSBmdXJ0aGVyLmApO1xuICAgICAgfVxuXG4gICAgICBydW5Qcm92aWRlcnMuYWRkUmV0cnkoe1xuICAgICAgICBpbnRlcnZhbCxcbiAgICAgICAgbWF4QXR0ZW1wdHMsXG4gICAgICAgIGJhY2tvZmZSYXRlLFxuICAgICAgICAvLyB3ZSByZXRyeSBvbiBldmVyeXRoaW5nXG4gICAgICAgIC8vIGRlbGV0ZWQgaWRsZSBydW5uZXJzIHdpbGwgYWxzbyBmYWlsLCBidXQgdGhlIHJlYXBlciB3aWxsIHN0b3AgdGhpcyBzdGVwIGZ1bmN0aW9uIHRvIGF2b2lkIGVuZGxlc3MgcmV0cmllc1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgbGV0IGxvZ09wdGlvbnM6IGNkay5hd3Nfc3RlcGZ1bmN0aW9ucy5Mb2dPcHRpb25zIHwgdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLnByb3BzPy5sb2dPcHRpb25zKSB7XG4gICAgICB0aGlzLnN0YXRlTWFjaGluZUxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0xvZ3MnLCB7XG4gICAgICAgIGxvZ0dyb3VwTmFtZTogcHJvcHM/LmxvZ09wdGlvbnM/LmxvZ0dyb3VwTmFtZSxcbiAgICAgICAgcmV0ZW50aW9uOiBwcm9wcz8ubG9nT3B0aW9ucz8ubG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICB9KTtcblxuICAgICAgbG9nT3B0aW9ucyA9IHtcbiAgICAgICAgZGVzdGluYXRpb246IHRoaXMuc3RhdGVNYWNoaW5lTG9nR3JvdXAsXG4gICAgICAgIGluY2x1ZGVFeGVjdXRpb25EYXRhOiBwcm9wcz8ubG9nT3B0aW9ucz8uaW5jbHVkZUV4ZWN1dGlvbkRhdGEgPz8gdHJ1ZSxcbiAgICAgICAgbGV2ZWw6IHByb3BzPy5sb2dPcHRpb25zPy5sZXZlbCA/PyBzdGVwZnVuY3Rpb25zLkxvZ0xldmVsLkFMTCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhdGVNYWNoaW5lID0gbmV3IHN0ZXBmdW5jdGlvbnMuU3RhdGVNYWNoaW5lKFxuICAgICAgdGhpcyxcbiAgICAgICdSdW5uZXIgT3JjaGVzdHJhdG9yJyxcbiAgICAgIHtcbiAgICAgICAgZGVmaW5pdGlvbkJvZHk6IHN0ZXBmdW5jdGlvbnMuRGVmaW5pdGlvbkJvZHkuZnJvbUNoYWluYWJsZShxdWV1ZUlkbGVSZWFwZXJUYXNrLm5leHQocnVuUHJvdmlkZXJzKSksXG4gICAgICAgIGxvZ3M6IGxvZ09wdGlvbnMsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBzdGF0ZU1hY2hpbmUuZ3JhbnRSZWFkKGlkbGVSZWFwZXIpO1xuICAgIHN0YXRlTWFjaGluZS5ncmFudEV4ZWN1dGlvbihpZGxlUmVhcGVyLCAnc3RhdGVzOlN0b3BFeGVjdXRpb24nKTtcbiAgICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIHRoaXMucHJvdmlkZXJzKSB7XG4gICAgICBwcm92aWRlci5ncmFudFN0YXRlTWFjaGluZShzdGF0ZU1hY2hpbmUpO1xuICAgIH1cblxuICAgIHJldHVybiBzdGF0ZU1hY2hpbmU7XG4gIH1cblxuICBwcml2YXRlIHRva2VuUmV0cmlldmVyKCkge1xuICAgIGNvbnN0IGZ1bmMgPSBuZXcgVG9rZW5SZXRyaWV2ZXJGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICAndG9rZW4tcmV0cmlldmVyJyxcbiAgICAgIHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdHZXQgdG9rZW4gZnJvbSBHaXRIdWIgQWN0aW9ucyB1c2VkIHRvIHN0YXJ0IG5ldyBzZWxmLWhvc3RlZCBydW5uZXInLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIEdJVEhVQl9TRUNSRVRfQVJOOiB0aGlzLnNlY3JldHMuZ2l0aHViLnNlY3JldEFybixcbiAgICAgICAgICBHSVRIVUJfUFJJVkFURV9LRVlfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuc2VjcmV0QXJuLFxuICAgICAgICAgIC4uLnRoaXMuZXh0cmFMYW1iZGFFbnYsXG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgICAgbG9nR3JvdXA6IHNpbmdsZXRvbkxvZ0dyb3VwKHRoaXMsIFNpbmdsZXRvbkxvZ1R5cGUuT1JDSEVTVFJBVE9SKSxcbiAgICAgICAgbG9nZ2luZ0Zvcm1hdDogbGFtYmRhLkxvZ2dpbmdGb3JtYXQuSlNPTixcbiAgICAgICAgLi4udGhpcy5leHRyYUxhbWJkYVByb3BzLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgdGhpcy5zZWNyZXRzLmdpdGh1Yi5ncmFudFJlYWQoZnVuYyk7XG4gICAgdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuZ3JhbnRSZWFkKGZ1bmMpO1xuXG4gICAgcmV0dXJuIGZ1bmM7XG4gIH1cblxuICBwcml2YXRlIGRlbGV0ZUZhaWxlZFJ1bm5lcigpIHtcbiAgICBjb25zdCBmdW5jID0gbmV3IERlbGV0ZUZhaWxlZFJ1bm5lckZ1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgICdkZWxldGUtcnVubmVyJyxcbiAgICAgIHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdEZWxldGUgZmFpbGVkIEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBvbiBlcnJvcicsXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgR0lUSFVCX1NFQ1JFVF9BUk46IHRoaXMuc2VjcmV0cy5naXRodWIuc2VjcmV0QXJuLFxuICAgICAgICAgIEdJVEhVQl9QUklWQVRFX0tFWV9TRUNSRVRfQVJOOiB0aGlzLnNlY3JldHMuZ2l0aHViUHJpdmF0ZUtleS5zZWNyZXRBcm4sXG4gICAgICAgICAgLi4udGhpcy5leHRyYUxhbWJkYUVudixcbiAgICAgICAgfSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICBsb2dHcm91cDogc2luZ2xldG9uTG9nR3JvdXAodGhpcywgU2luZ2xldG9uTG9nVHlwZS5PUkNIRVNUUkFUT1IpLFxuICAgICAgICBsb2dnaW5nRm9ybWF0OiBsYW1iZGEuTG9nZ2luZ0Zvcm1hdC5KU09OLFxuICAgICAgICAuLi50aGlzLmV4dHJhTGFtYmRhUHJvcHMsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICB0aGlzLnNlY3JldHMuZ2l0aHViLmdyYW50UmVhZChmdW5jKTtcbiAgICB0aGlzLnNlY3JldHMuZ2l0aHViUHJpdmF0ZUtleS5ncmFudFJlYWQoZnVuYyk7XG5cbiAgICByZXR1cm4gZnVuYztcbiAgfVxuXG4gIHByaXZhdGUgc3RhdHVzRnVuY3Rpb24oKSB7XG4gICAgY29uc3Qgc3RhdHVzRnVuY3Rpb24gPSBuZXcgU3RhdHVzRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgJ3N0YXR1cycsXG4gICAgICB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnUHJvdmlkZSB1c2VyIHdpdGggc3RhdHVzIGFib3V0IHNlbGYtaG9zdGVkIEdpdEh1YiBBY3Rpb25zIHJ1bm5lcnMnLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIFdFQkhPT0tfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLndlYmhvb2suc2VjcmV0QXJuLFxuICAgICAgICAgIEdJVEhVQl9TRUNSRVRfQVJOOiB0aGlzLnNlY3JldHMuZ2l0aHViLnNlY3JldEFybixcbiAgICAgICAgICBHSVRIVUJfUFJJVkFURV9LRVlfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuc2VjcmV0QXJuLFxuICAgICAgICAgIFNFVFVQX1NFQ1JFVF9BUk46IHRoaXMuc2VjcmV0cy5zZXR1cC5zZWNyZXRBcm4sXG4gICAgICAgICAgV0VCSE9PS19VUkw6IHRoaXMud2ViaG9vay51cmwsXG4gICAgICAgICAgV0VCSE9PS19IQU5ETEVSX0FSTjogdGhpcy53ZWJob29rLmhhbmRsZXIubGF0ZXN0VmVyc2lvbi5mdW5jdGlvbkFybixcbiAgICAgICAgICBTVEVQX0ZVTkNUSU9OX0FSTjogdGhpcy5vcmNoZXN0cmF0b3Iuc3RhdGVNYWNoaW5lQXJuLFxuICAgICAgICAgIFNURVBfRlVOQ1RJT05fTE9HX0dST1VQOiB0aGlzLnN0YXRlTWFjaGluZUxvZ0dyb3VwPy5sb2dHcm91cE5hbWUgPz8gJycsXG4gICAgICAgICAgU0VUVVBfRlVOQ1RJT05fVVJMOiB0aGlzLnNldHVwVXJsLFxuICAgICAgICAgIC4uLnRoaXMuZXh0cmFMYW1iZGFFbnYsXG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDMpLFxuICAgICAgICBsb2dHcm91cDogc2luZ2xldG9uTG9nR3JvdXAodGhpcywgU2luZ2xldG9uTG9nVHlwZS5TRVRVUCksXG4gICAgICAgIGxvZ2dpbmdGb3JtYXQ6IGxhbWJkYS5Mb2dnaW5nRm9ybWF0LkpTT04sXG4gICAgICAgIC4uLnRoaXMuZXh0cmFMYW1iZGFQcm9wcyxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IHByb3ZpZGVycyA9IHRoaXMucHJvdmlkZXJzLmZsYXRNYXAocHJvdmlkZXIgPT4ge1xuICAgICAgY29uc3Qgc3RhdHVzID0gcHJvdmlkZXIuc3RhdHVzKHN0YXR1c0Z1bmN0aW9uKTtcbiAgICAgIC8vIENvbXBvc2l0ZSBwcm92aWRlcnMgcmV0dXJuIGFuIGFycmF5LCByZWd1bGFyIHByb3ZpZGVycyByZXR1cm4gYSBzaW5nbGUgc3RhdHVzXG4gICAgICByZXR1cm4gQXJyYXkuaXNBcnJheShzdGF0dXMpID8gc3RhdHVzIDogW3N0YXR1c107XG4gICAgfSk7XG5cbiAgICAvLyBleHBvc2UgcHJvdmlkZXJzIGFzIHN0YWNrIG1ldGFkYXRhIGFzIGl0J3MgdG9vIGJpZyBmb3IgTGFtYmRhIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgIC8vIHNwZWNpZmljYWxseSBpbnRlZ3JhdGlvbiB0ZXN0aW5nIGdvdCBhbiBlcnJvciBiZWNhdXNlIGxhbWJkYSB1cGRhdGUgcmVxdWVzdCB3YXMgPjVrYlxuICAgIGNvbnN0IHN0YWNrID0gY2RrLlN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IGYgPSAoc3RhdHVzRnVuY3Rpb24ubm9kZS5kZWZhdWx0Q2hpbGQgYXMgbGFtYmRhLkNmbkZ1bmN0aW9uKTtcbiAgICBmLmFkZFByb3BlcnR5T3ZlcnJpZGUoJ0Vudmlyb25tZW50LlZhcmlhYmxlcy5MT0dJQ0FMX0lEJywgZi5sb2dpY2FsSWQpO1xuICAgIGYuYWRkUHJvcGVydHlPdmVycmlkZSgnRW52aXJvbm1lbnQuVmFyaWFibGVzLlNUQUNLX05BTUUnLCBzdGFjay5zdGFja05hbWUpO1xuICAgIGYuYWRkTWV0YWRhdGEoJ3Byb3ZpZGVycycsIHByb3ZpZGVycyk7XG4gICAgc3RhdHVzRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnY2xvdWRmb3JtYXRpb246RGVzY3JpYmVTdGFja1Jlc291cmNlJ10sXG4gICAgICByZXNvdXJjZXM6IFtzdGFjay5zdGFja0lkXSxcbiAgICB9KSk7XG5cbiAgICB0aGlzLnNlY3JldHMud2ViaG9vay5ncmFudFJlYWQoc3RhdHVzRnVuY3Rpb24pO1xuICAgIHRoaXMuc2VjcmV0cy5naXRodWIuZ3JhbnRSZWFkKHN0YXR1c0Z1bmN0aW9uKTtcbiAgICB0aGlzLnNlY3JldHMuZ2l0aHViUHJpdmF0ZUtleS5ncmFudFJlYWQoc3RhdHVzRnVuY3Rpb24pO1xuICAgIHRoaXMuc2VjcmV0cy5zZXR1cC5ncmFudFJlYWQoc3RhdHVzRnVuY3Rpb24pO1xuICAgIHRoaXMub3JjaGVzdHJhdG9yLmdyYW50UmVhZChzdGF0dXNGdW5jdGlvbik7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dChcbiAgICAgIHRoaXMsXG4gICAgICAnc3RhdHVzIGNvbW1hbmQnLFxuICAgICAge1xuICAgICAgICB2YWx1ZTogYGF3cyAtLXJlZ2lvbiAke3N0YWNrLnJlZ2lvbn0gbGFtYmRhIGludm9rZSAtLWZ1bmN0aW9uLW5hbWUgJHtzdGF0dXNGdW5jdGlvbi5mdW5jdGlvbk5hbWV9IHN0YXR1cy5qc29uYCxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IGFjY2VzcyA9IHRoaXMucHJvcHM/LnN0YXR1c0FjY2VzcyA/PyBMYW1iZGFBY2Nlc3Mubm9BY2Nlc3MoKTtcbiAgICBjb25zdCB1cmwgPSBhY2Nlc3MuYmluZCh0aGlzLCAnc3RhdHVzIGFjY2VzcycsIHN0YXR1c0Z1bmN0aW9uKTtcblxuICAgIGlmICh1cmwgIT09ICcnKSB7XG4gICAgICBuZXcgY2RrLkNmbk91dHB1dChcbiAgICAgICAgdGhpcyxcbiAgICAgICAgJ3N0YXR1cyB1cmwnLFxuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IHVybCxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEZ1bmN0aW9uKCk6IHN0cmluZyB7XG4gICAgY29uc3Qgc2V0dXBGdW5jdGlvbiA9IG5ldyBTZXR1cEZ1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgICdzZXR1cCcsXG4gICAgICB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU2V0dXAgR2l0SHViIEFjdGlvbnMgaW50ZWdyYXRpb24gd2l0aCBzZWxmLWhvc3RlZCBydW5uZXJzJyxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBTRVRVUF9TRUNSRVRfQVJOOiB0aGlzLnNlY3JldHMuc2V0dXAuc2VjcmV0QXJuLFxuICAgICAgICAgIFdFQkhPT0tfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLndlYmhvb2suc2VjcmV0QXJuLFxuICAgICAgICAgIEdJVEhVQl9TRUNSRVRfQVJOOiB0aGlzLnNlY3JldHMuZ2l0aHViLnNlY3JldEFybixcbiAgICAgICAgICBHSVRIVUJfUFJJVkFURV9LRVlfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuc2VjcmV0QXJuLFxuICAgICAgICAgIFdFQkhPT0tfVVJMOiB0aGlzLndlYmhvb2sudXJsLFxuICAgICAgICAgIC4uLnRoaXMuZXh0cmFMYW1iZGFFbnYsXG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDMpLFxuICAgICAgICBsb2dHcm91cDogc2luZ2xldG9uTG9nR3JvdXAodGhpcywgU2luZ2xldG9uTG9nVHlwZS5TRVRVUCksXG4gICAgICAgIGxvZ2dpbmdGb3JtYXQ6IGxhbWJkYS5Mb2dnaW5nRm9ybWF0LkpTT04sXG4gICAgICAgIC4uLnRoaXMuZXh0cmFMYW1iZGFQcm9wcyxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIC8vIHRoaXMuc2VjcmV0cy53ZWJob29rLmdyYW50UmVhZChzZXR1cEZ1bmN0aW9uKTtcbiAgICB0aGlzLnNlY3JldHMud2ViaG9vay5ncmFudFdyaXRlKHNldHVwRnVuY3Rpb24pO1xuICAgIHRoaXMuc2VjcmV0cy5naXRodWIuZ3JhbnRSZWFkKHNldHVwRnVuY3Rpb24pO1xuICAgIHRoaXMuc2VjcmV0cy5naXRodWIuZ3JhbnRXcml0ZShzZXR1cEZ1bmN0aW9uKTtcbiAgICAvLyB0aGlzLnNlY3JldHMuZ2l0aHViUHJpdmF0ZUtleS5ncmFudFJlYWQoc2V0dXBGdW5jdGlvbik7XG4gICAgdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuZ3JhbnRXcml0ZShzZXR1cEZ1bmN0aW9uKTtcbiAgICB0aGlzLnNlY3JldHMuc2V0dXAuZ3JhbnRSZWFkKHNldHVwRnVuY3Rpb24pO1xuICAgIHRoaXMuc2VjcmV0cy5zZXR1cC5ncmFudFdyaXRlKHNldHVwRnVuY3Rpb24pO1xuXG4gICAgY29uc3QgYWNjZXNzID0gdGhpcy5wcm9wcz8uc2V0dXBBY2Nlc3MgPz8gTGFtYmRhQWNjZXNzLmxhbWJkYVVybCgpO1xuICAgIHJldHVybiBhY2Nlc3MuYmluZCh0aGlzLCAnc2V0dXAgYWNjZXNzJywgc2V0dXBGdW5jdGlvbik7XG4gIH1cblxuICBwcml2YXRlIGNoZWNrSW50ZXJzZWN0aW5nTGFiZWxzKCkge1xuICAgIC8vIHRoaXMgXCJhbGdvcml0aG1cIiBpcyB2ZXJ5IGluZWZmaWNpZW50LCBidXQgZ29vZCBlbm91Z2ggZm9yIHRoZSB0aW55IGRhdGFzZXRzIHdlIGV4cGVjdFxuICAgIGZvciAoY29uc3QgcDEgb2YgdGhpcy5wcm92aWRlcnMpIHtcbiAgICAgIGZvciAoY29uc3QgcDIgb2YgdGhpcy5wcm92aWRlcnMpIHtcbiAgICAgICAgaWYgKHAxID09IHAyKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHAxLmxhYmVscy5ldmVyeShsID0+IHAyLmxhYmVscy5pbmNsdWRlcyhsKSkpIHtcbiAgICAgICAgICBpZiAocDIubGFiZWxzLmV2ZXJ5KGwgPT4gcDEubGFiZWxzLmluY2x1ZGVzKGwpKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBCb3RoICR7cDEubm9kZS5wYXRofSBhbmQgJHtwMi5ub2RlLnBhdGh9IHVzZSB0aGUgc2FtZSBsYWJlbHMgWyR7cDEubGFiZWxzLmpvaW4oJywgJyl9XWApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBBbm5vdGF0aW9ucy5vZihwMSkuYWRkV2FybmluZyhgTGFiZWxzIFske3AxLmxhYmVscy5qb2luKCcsICcpfV0gaW50ZXJzZWN0IHdpdGggYW5vdGhlciBwcm92aWRlciAoJHtwMi5ub2RlLnBhdGh9IC0tIFske3AyLmxhYmVscy5qb2luKCcsICcpfV0pLiBJZiBhIHdvcmtmbG93IHNwZWNpZmllcyB0aGUgbGFiZWxzIFske3AxLmxhYmVscy5qb2luKCcsICcpfV0sIGl0IGlzIG5vdCBndWFyYW50ZWVkIHdoaWNoIHByb3ZpZGVyIHdpbGwgYmUgdXNlZC4gSXQgaXMgcmVjb21tZW5kZWQgeW91IGRvIG5vdCB1c2UgaW50ZXJzZWN0aW5nIGxhYmVsc2ApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBpZGxlUmVhcGVyKCkge1xuICAgIHJldHVybiBuZXcgSWRsZVJ1bm5lclJlcGVhckZ1bmN0aW9uKHRoaXMsICdJZGxlIFJlYXBlcicsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3RvcCBpZGxlIEdpdEh1YiBydW5uZXJzIHRvIGF2b2lkIHBheWluZyBmb3IgcnVubmVycyB3aGVuIHRoZSBqb2Igd2FzIGFscmVhZHkgY2FuY2VsZWQnLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgR0lUSFVCX1NFQ1JFVF9BUk46IHRoaXMuc2VjcmV0cy5naXRodWIuc2VjcmV0QXJuLFxuICAgICAgICBHSVRIVUJfUFJJVkFURV9LRVlfU0VDUkVUX0FSTjogdGhpcy5zZWNyZXRzLmdpdGh1YlByaXZhdGVLZXkuc2VjcmV0QXJuLFxuICAgICAgICAuLi50aGlzLmV4dHJhTGFtYmRhRW52LFxuICAgICAgfSxcbiAgICAgIGxvZ0dyb3VwOiBzaW5nbGV0b25Mb2dHcm91cCh0aGlzLCBTaW5nbGV0b25Mb2dUeXBlLk9SQ0hFU1RSQVRPUiksXG4gICAgICBsb2dnaW5nRm9ybWF0OiBsYW1iZGEuTG9nZ2luZ0Zvcm1hdC5KU09OLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAuLi50aGlzLmV4dHJhTGFtYmRhUHJvcHMsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGlkbGVSZWFwZXJRdWV1ZShyZWFwZXI6IGxhbWJkYS5GdW5jdGlvbikge1xuICAgIC8vIHNlZSB0aGlzIGNvbW1lbnQgdG8gdW5kZXJzdGFuZCB3aHkgaXQncyBhIHF1ZXVlIHRoYXQncyBvdXQgb2YgdGhlIHN0ZXAgZnVuY3Rpb25cbiAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vQ2xvdWRTbm9ya2VsL2Nkay1naXRodWItcnVubmVycy9wdWxsLzMxNCNpc3N1ZWNvbW1lbnQtMTUyODkwMTE5MlxuXG4gICAgY29uc3QgcXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdJZGxlIFJlYXBlciBRdWV1ZScsIHtcbiAgICAgIGRlbGl2ZXJ5RGVsYXk6IGNkay5EdXJhdGlvbi5taW51dGVzKDEwKSxcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxMCksXG4gICAgfSk7XG5cbiAgICByZWFwZXIuYWRkRXZlbnRTb3VyY2UobmV3IGxhbWJkYV9ldmVudF9zb3VyY2VzLlNxc0V2ZW50U291cmNlKHF1ZXVlLCB7XG4gICAgICByZXBvcnRCYXRjaEl0ZW1GYWlsdXJlczogdHJ1ZSxcbiAgICAgIG1heEJhdGNoaW5nV2luZG93OiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICB9KSk7XG5cbiAgICB0aGlzLnNlY3JldHMuZ2l0aHViLmdyYW50UmVhZChyZWFwZXIpO1xuICAgIHRoaXMuc2VjcmV0cy5naXRodWJQcml2YXRlS2V5LmdyYW50UmVhZChyZWFwZXIpO1xuXG4gICAgcmV0dXJuIHF1ZXVlO1xuICB9XG5cbiAgcHJpdmF0ZSBsYW1iZGFTZWN1cml0eUdyb3VwcygpIHtcbiAgICBpZiAoIXRoaXMucHJvcHM/LnZwYykge1xuICAgICAgaWYgKHRoaXMucHJvcHM/LnNlY3VyaXR5R3JvdXApIHtcbiAgICAgICAgY2RrLkFubm90YXRpb25zLm9mKHRoaXMpLmFkZFdhcm5pbmcoJ3NlY3VyaXR5R3JvdXAgaXMgc3BlY2lmaWVkLCBidXQgdnBjIGlzIG5vdC4gc2VjdXJpdHlHcm91cCB3aWxsIGJlIGlnbm9yZWQnKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLnByb3BzPy5zZWN1cml0eUdyb3Vwcykge1xuICAgICAgICBjZGsuQW5ub3RhdGlvbnMub2YodGhpcykuYWRkV2FybmluZygnc2VjdXJpdHlHcm91cHMgaXMgc3BlY2lmaWVkLCBidXQgdnBjIGlzIG5vdC4gc2VjdXJpdHlHcm91cHMgd2lsbCBiZSBpZ25vcmVkJyk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMucHJvcHMuc2VjdXJpdHlHcm91cHMpIHtcbiAgICAgIGlmICh0aGlzLnByb3BzLnNlY3VyaXR5R3JvdXApIHtcbiAgICAgICAgY2RrLkFubm90YXRpb25zLm9mKHRoaXMpLmFkZFdhcm5pbmcoJ0JvdGggc2VjdXJpdHlHcm91cCBhbmQgc2VjdXJpdHlHcm91cHMgYXJlIHNwZWNpZmllZC4gc2VjdXJpdHlHcm91cCB3aWxsIGJlIGlnbm9yZWQnKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLnByb3BzLnNlY3VyaXR5R3JvdXBzO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnByb3BzLnNlY3VyaXR5R3JvdXApIHtcbiAgICAgIHJldHVybiBbdGhpcy5wcm9wcy5zZWN1cml0eUdyb3VwXTtcbiAgICB9XG5cbiAgICByZXR1cm4gW25ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnTWFuYWdlbWVudCBMYW1iZGFzIFNlY3VyaXR5IEdyb3VwJywgeyB2cGM6IHRoaXMucHJvcHMudnBjIH0pXTtcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHRyYWN0cyBhbGwgdW5pcXVlIElSdW5uZXJQcm92aWRlciBpbnN0YW5jZXMgZnJvbSBwcm92aWRlcnMgYW5kIGNvbXBvc2l0ZSBwcm92aWRlcnMgKG9uZSBsZXZlbCBvbmx5KS5cbiAgICogVXNlcyBhIFNldCB0byBlbnN1cmUgd2UgZG9uJ3QgcHJvY2VzcyB0aGUgc2FtZSBwcm92aWRlciB0d2ljZSwgZXZlbiBpZiBpdCdzIHVzZWQgaW4gbXVsdGlwbGUgY29tcG9zaXRlcy5cbiAgICpcbiAgICogQHJldHVybnMgU2V0IG9mIHVuaXF1ZSBJUnVubmVyUHJvdmlkZXIgaW5zdGFuY2VzXG4gICAqL1xuICBwcml2YXRlIGV4dHJhY3RVbmlxdWVTdWJQcm92aWRlcnMoKTogU2V0PElSdW5uZXJQcm92aWRlcj4ge1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PElSdW5uZXJQcm92aWRlcj4oKTtcbiAgICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIHRoaXMucHJvdmlkZXJzKSB7XG4gICAgICAvLyBpbnN0YW5jZW9mIGRvZXNuJ3QgcmVhbGx5IHdvcmsgaW4gQ0RLIHNvIHVzZSB0aGlzIGhhY2sgaW5zdGVhZFxuICAgICAgaWYgKCdsb2dHcm91cCcgaW4gcHJvdmlkZXIpIHtcbiAgICAgICAgLy8gUmVndWxhciBwcm92aWRlclxuICAgICAgICBzZWVuLmFkZChwcm92aWRlcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBDb21wb3NpdGUgcHJvdmlkZXIgLSBhY2Nlc3MgdGhlIHByb3ZpZGVycyBmaWVsZFxuICAgICAgICBmb3IgKGNvbnN0IHN1YlByb3ZpZGVyIG9mIHByb3ZpZGVyLnByb3ZpZGVycykge1xuICAgICAgICAgIHNlZW4uYWRkKHN1YlByb3ZpZGVyKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gc2VlbjtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGEgTGFtYmRhIGxheWVyIHdpdGggY2VydGlmaWNhdGVzIGlmIGV4dHJhQ2VydGlmaWNhdGVzIGlzIHNwZWNpZmllZC5cbiAgICovXG4gIHByaXZhdGUgY3JlYXRlQ2VydGlmaWNhdGVMYXllcihzY29wZTogQ29uc3RydWN0KTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnByb3BzPy5leHRyYUNlcnRpZmljYXRlcykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGNlcnRpZmljYXRlRmlsZXMgPSBkaXNjb3ZlckNlcnRpZmljYXRlRmlsZXModGhpcy5wcm9wcy5leHRyYUNlcnRpZmljYXRlcyk7XG5cbiAgICAvLyBDb25jYXRlbmF0ZSBhbGwgY2VydGlmaWNhdGVzIGludG8gYSBzaW5nbGUgZmlsZSBmb3IgTk9ERV9FWFRSQV9DQV9DRVJUU1xuICAgIGxldCBjb21iaW5lZENlcnRDb250ZW50ID0gJyc7XG4gICAgZm9yIChjb25zdCBjZXJ0RmlsZSBvZiBjZXJ0aWZpY2F0ZUZpbGVzKSB7XG4gICAgICBjb25zdCBjZXJ0Q29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhjZXJ0RmlsZSwgJ3V0ZjgnKTtcbiAgICAgIGNvbWJpbmVkQ2VydENvbnRlbnQgKz0gY2VydENvbnRlbnQ7XG4gICAgICAvLyBFbnN1cmUgcHJvcGVyIFBFTSBmb3JtYXQgd2l0aCBuZXdsaW5lIGJldHdlZW4gY2VydGlmaWNhdGVzXG4gICAgICBpZiAoIWNlcnRDb250ZW50LmVuZHNXaXRoKCdcXG4nKSkge1xuICAgICAgICBjb21iaW5lZENlcnRDb250ZW50ICs9ICdcXG4nO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENyZWF0ZSBhIHRlbXBvcmFyeSBkaXJlY3RvcnksIHdyaXRlIHRoZSBjZXJ0aWZpY2F0ZSBmaWxlLCBjcmVhdGUgYXNzZXQsIHRoZW4gZGVsZXRlIHRlbXAgZGlyXG4gICAgY29uc3Qgd29ya2RpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2NlcnRpZmljYXRlLWxheWVyLScpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY2VydFBhdGggPSBwYXRoLmpvaW4od29ya2RpciwgJ2NlcnRzLnBlbScpO1xuICAgICAgZnMud3JpdGVGaWxlU3luYyhjZXJ0UGF0aCwgY29tYmluZWRDZXJ0Q29udGVudCk7XG5cbiAgICAgIC8vIFNldCBlbnZpcm9ubWVudCB2YXJpYWJsZSBhbmQgY3JlYXRlIGxheWVyXG4gICAgICB0aGlzLmV4dHJhTGFtYmRhRW52Lk5PREVfRVhUUkFfQ0FfQ0VSVFMgPSAnL29wdC9jZXJ0cy5wZW0nO1xuICAgICAgdGhpcy5leHRyYUxhbWJkYVByb3BzLmxheWVycyEucHVzaChcbiAgICAgICAgbmV3IGxhbWJkYS5MYXllclZlcnNpb24oc2NvcGUsICdDZXJ0aWZpY2F0ZSBMYXllcicsIHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0xheWVyIGNvbnRhaW5pbmcgR2l0SHViIEVudGVycHJpc2UgU2VydmVyIGNlcnRpZmljYXRlKHMpIGZvciBjZGstZ2l0aHViLXJ1bm5lcnMnLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCh3b3JrZGlyKSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAvLyBDYWxsaW5nIGBmcm9tQXNzZXQoKWAgaGFzIGNvcGllZCBmaWxlcyB0byB0aGUgYXNzZW1ibHksIHNvIHdlIGNhbiBkZWxldGUgdGhlIHRlbXBvcmFyeSBkaXJlY3RvcnkuXG4gICAgICBmcy5ybVN5bmMod29ya2RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBNZXRyaWMgZm9yIHRoZSBudW1iZXIgb2YgR2l0SHViIEFjdGlvbnMgam9icyBjb21wbGV0ZWQuIEl0IGhhcyBgUHJvdmlkZXJMYWJlbHNgIGFuZCBgU3RhdHVzYCBkaW1lbnNpb25zLiBUaGUgc3RhdHVzIGNhbiBiZSBvbmUgb2YgXCJTdWNjZWVkZWRcIiwgXCJTdWNjZWVkZWRXaXRoSXNzdWVzXCIsIFwiRmFpbGVkXCIsIFwiQ2FuY2VsZWRcIiwgXCJTa2lwcGVkXCIsIG9yIFwiQWJhbmRvbmVkXCIuXG4gICAqXG4gICAqICoqV0FSTklORzoqKiB0aGlzIG1ldGhvZCBjcmVhdGVzIGEgbWV0cmljIGZpbHRlciBmb3IgZWFjaCBwcm92aWRlci4gRWFjaCBtZXRyaWMgaGFzIGEgc3RhdHVzIGRpbWVuc2lvbiB3aXRoIHNpeCBwb3NzaWJsZSB2YWx1ZXMuIFRoZXNlIHJlc291cmNlcyBtYXkgaW5jdXIgY29zdC5cbiAgICovXG4gIHB1YmxpYyBtZXRyaWNKb2JDb21wbGV0ZWQocHJvcHM/OiBjbG91ZHdhdGNoLk1ldHJpY09wdGlvbnMpOiBjbG91ZHdhdGNoLk1ldHJpYyB7XG4gICAgaWYgKCF0aGlzLmpvYnNDb21wbGV0ZWRNZXRyaWNGaWx0ZXJzSW5pdGlhbGl6ZWQpIHtcbiAgICAgIC8vIHdlIGNhbid0IHVzZSBsb2dzLkZpbHRlclBhdHRlcm4uc3BhY2VEZWxpbWl0ZWQoKSBiZWNhdXNlIGl0IGhhcyBubyBzdXBwb3J0IGZvciB8fFxuICAgICAgLy8gc3RhdHVzIGxpc3QgdGFrZW4gZnJvbSBodHRwczovL2dpdGh1Yi5jb20vYWN0aW9ucy9ydW5uZXIvYmxvYi9iZTk2MzIzMDJjZWVmNTBiZmIzNmVhOTk4Y2VhOWM5NGM3NWU1ZDRkL3NyYy9TZGsvRFRXZWJBcGkvV2ViQXBpL1Rhc2tSZXN1bHQuY3NcbiAgICAgIC8vIHdlIG5lZWQgXCIuLi5cIiBmb3IgTGFtYmRhIHRoYXQgcHJlZml4ZXMgc29tZSBleHRyYSBkYXRhIHRvIGxvZyBsaW5lc1xuICAgICAgY29uc3QgcGF0dGVybiA9IGxvZ3MuRmlsdGVyUGF0dGVybi5saXRlcmFsKCdbLi4uLCBtYXJrZXIgPSBcIkNES0dIQVwiLCBqb2IgPSBcIkpPQlwiLCBkb25lID0gXCJET05FXCIsIGxhYmVscywgc3RhdHVzID0gXCJTdWNjZWVkZWRcIiB8fCBzdGF0dXMgPSBcIlN1Y2NlZWRlZFdpdGhJc3N1ZXNcIiB8fCBzdGF0dXMgPSBcIkZhaWxlZFwiIHx8IHN0YXR1cyA9IFwiQ2FuY2VsZWRcIiB8fCBzdGF0dXMgPSBcIlNraXBwZWRcIiB8fCBzdGF0dXMgPSBcIkFiYW5kb25lZFwiXScpO1xuXG4gICAgICAvLyBFeHRyYWN0IGFsbCB1bmlxdWUgc3ViLXByb3ZpZGVycyBmcm9tIHJlZ3VsYXIgYW5kIGNvbXBvc2l0ZSBwcm92aWRlcnNcbiAgICAgIC8vIEJ1aWxkIGEgc2V0IGZpcnN0IHRvIGF2b2lkIGZpbHRlcmluZyB0aGUgc2FtZSBsb2cgdHdpY2VcbiAgICAgIGZvciAoY29uc3QgcCBvZiB0aGlzLmV4dHJhY3RVbmlxdWVTdWJQcm92aWRlcnMoKSkge1xuICAgICAgICBjb25zdCBtZXRyaWNGaWx0ZXIgPSBwLmxvZ0dyb3VwLmFkZE1ldHJpY0ZpbHRlcihgJHtwLmxvZ0dyb3VwLm5vZGUuaWR9IGZpbHRlcmAsIHtcbiAgICAgICAgICBtZXRyaWNOYW1lc3BhY2U6ICdHaXRIdWJSdW5uZXJzJyxcbiAgICAgICAgICBtZXRyaWNOYW1lOiAnSm9iQ29tcGxldGVkJyxcbiAgICAgICAgICBmaWx0ZXJQYXR0ZXJuOiBwYXR0ZXJuLFxuICAgICAgICAgIG1ldHJpY1ZhbHVlOiAnMScsXG4gICAgICAgICAgLy8gY2FuJ3Qgd2l0aCBkaW1lbnNpb25zIC0tIGRlZmF1bHRWYWx1ZTogMCxcbiAgICAgICAgICBkaW1lbnNpb25zOiB7XG4gICAgICAgICAgICBQcm92aWRlckxhYmVsczogJyRsYWJlbHMnLFxuICAgICAgICAgICAgU3RhdHVzOiAnJHN0YXR1cycsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKG1ldHJpY0ZpbHRlci5ub2RlLmRlZmF1bHRDaGlsZCBpbnN0YW5jZW9mIGxvZ3MuQ2ZuTWV0cmljRmlsdGVyKSB7XG4gICAgICAgICAgbWV0cmljRmlsdGVyLm5vZGUuZGVmYXVsdENoaWxkLmFkZFByb3BlcnR5T3ZlcnJpZGUoJ01ldHJpY1RyYW5zZm9ybWF0aW9ucy4wLlVuaXQnLCAnQ291bnQnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBBbm5vdGF0aW9ucy5vZihtZXRyaWNGaWx0ZXIpLmFkZFdhcm5pbmcoJ1VuYWJsZSB0byBzZXQgbWV0cmljIGZpbHRlciBVbml0IHRvIENvdW50Jyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRoaXMuam9ic0NvbXBsZXRlZE1ldHJpY0ZpbHRlcnNJbml0aWFsaXplZCA9IHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdHaXRIdWJSdW5uZXJzJyxcbiAgICAgIG1ldHJpY05hbWU6ICdKb2JzQ29tcGxldGVkJyxcbiAgICAgIHVuaXQ6IGNsb3Vkd2F0Y2guVW5pdC5DT1VOVCxcbiAgICAgIHN0YXRpc3RpYzogY2xvdWR3YXRjaC5TdGF0cy5TVU0sXG4gICAgICAuLi5wcm9wcyxcbiAgICB9KS5hdHRhY2hUbyh0aGlzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBNZXRyaWMgZm9yIHN1Y2Nlc3NmdWwgZXhlY3V0aW9ucy5cbiAgICpcbiAgICogQSBzdWNjZXNzZnVsIGV4ZWN1dGlvbiBkb2Vzbid0IGFsd2F5cyBtZWFuIGEgcnVubmVyIHdhcyBzdGFydGVkLiBJdCBjYW4gYmUgc3VjY2Vzc2Z1bCBldmVuIHdpdGhvdXQgYW55IGxhYmVsIG1hdGNoZXMuXG4gICAqXG4gICAqIEEgc3VjY2Vzc2Z1bCBydW5uZXIgZG9lc24ndCBtZWFuIHRoZSBqb2IgaXQgZXhlY3V0ZWQgd2FzIHN1Y2Nlc3NmdWwuIEZvciB0aGF0LCBzZWUge0BsaW5rIG1ldHJpY0pvYkNvbXBsZXRlZH0uXG4gICAqL1xuICBwdWJsaWMgbWV0cmljU3VjY2VlZGVkKHByb3BzPzogY2xvdWR3YXRjaC5NZXRyaWNPcHRpb25zKTogY2xvdWR3YXRjaC5NZXRyaWMge1xuICAgIHJldHVybiB0aGlzLm9yY2hlc3RyYXRvci5tZXRyaWNTdWNjZWVkZWQocHJvcHMpO1xuICB9XG5cbiAgLyoqXG4gICAqIE1ldHJpYyBmb3IgZmFpbGVkIHJ1bm5lciBleGVjdXRpb25zLlxuICAgKlxuICAgKiBBIGZhaWxlZCBydW5uZXIgdXN1YWxseSBtZWFucyB0aGUgcnVubmVyIGZhaWxlZCB0byBzdGFydCBhbmQgc28gYSBqb2Igd2FzIG5ldmVyIGV4ZWN1dGVkLiBJdCBkb2Vzbid0IG5lY2Vzc2FyaWx5IG1lYW4gdGhlIGpvYiB3YXMgZXhlY3V0ZWQgYW5kIGZhaWxlZC4gRm9yIHRoYXQsIHNlZSB7QGxpbmsgbWV0cmljSm9iQ29tcGxldGVkfS5cbiAgICovXG4gIHB1YmxpYyBtZXRyaWNGYWlsZWQocHJvcHM/OiBjbG91ZHdhdGNoLk1ldHJpY09wdGlvbnMpOiBjbG91ZHdhdGNoLk1ldHJpYyB7XG4gICAgcmV0dXJuIHRoaXMub3JjaGVzdHJhdG9yLm1ldHJpY0ZhaWxlZChwcm9wcyk7XG4gIH1cblxuICAvKipcbiAgICogTWV0cmljIGZvciB0aGUgaW50ZXJ2YWwsIGluIG1pbGxpc2Vjb25kcywgYmV0d2VlbiB0aGUgdGltZSB0aGUgZXhlY3V0aW9uIHN0YXJ0cyBhbmQgdGhlIHRpbWUgaXQgY2xvc2VzLiBUaGlzIHRpbWUgbWF5IGJlIGxvbmdlciB0aGFuIHRoZSB0aW1lIHRoZSBydW5uZXIgdG9vay5cbiAgICovXG4gIHB1YmxpYyBtZXRyaWNUaW1lKHByb3BzPzogY2xvdWR3YXRjaC5NZXRyaWNPcHRpb25zKTogY2xvdWR3YXRjaC5NZXRyaWMge1xuICAgIHJldHVybiB0aGlzLm9yY2hlc3RyYXRvci5tZXRyaWNUaW1lKHByb3BzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGEgdG9waWMgZm9yIG5vdGlmaWNhdGlvbnMgd2hlbiBhIHJ1bm5lciBpbWFnZSBidWlsZCBmYWlscy5cbiAgICpcbiAgICogUnVubmVyIGltYWdlcyBhcmUgcmVidWlsdCBldmVyeSB3ZWVrIGJ5IGRlZmF1bHQuIFRoaXMgcHJvdmlkZXMgdGhlIGxhdGVzdCBHaXRIdWIgUnVubmVyIHZlcnNpb24gYW5kIHNvZnR3YXJlIHVwZGF0ZXMuXG4gICAqXG4gICAqIElmIHlvdSB3YW50IHRvIGJlIHN1cmUgeW91IGFyZSB1c2luZyB0aGUgbGF0ZXN0IHJ1bm5lciB2ZXJzaW9uLCB5b3UgY2FuIHVzZSB0aGlzIHRvcGljIHRvIGJlIG5vdGlmaWVkIHdoZW4gYSBidWlsZCBmYWlscy5cbiAgICpcbiAgICogV2hlbiB0aGUgaW1hZ2UgYnVpbGRlciBpcyBkZWZpbmVkIGluIGEgc2VwYXJhdGUgc3RhY2sgKGUuZy4gaW4gYSBzcGxpdC1zdGFja3Mgc2V0dXApLCBwYXNzIHRoYXQgc3RhY2sgb3IgY29uc3RydWN0XG4gICAqIGFzIHRoZSBvcHRpb25hbCBzY29wZSBzbyB0aGUgdG9waWMgYW5kIGZhaWx1cmUtbm90aWZpY2F0aW9uIGFzcGVjdHMgYXJlIGNyZWF0ZWQgaW4gdGhlIHNhbWUgc3RhY2sgYXMgdGhlIGltYWdlXG4gICAqIGJ1aWxkZXIuIE90aGVyd2lzZSB0aGUgYXNwZWN0cyBtYXkgbm90IGZpbmQgdGhlIGltYWdlIGJ1aWxkZXIgcmVzb3VyY2VzLlxuICAgKlxuICAgKiBAcGFyYW0gc2NvcGUgT3B0aW9uYWwgc2NvcGUgKGUuZy4gdGhlIGltYWdlIGJ1aWxkZXIgc3RhY2spIHdoZXJlIHRoZSB0b3BpYyBhbmQgYXNwZWN0cyB3aWxsIGJlIGNyZWF0ZWQuIERlZmF1bHRzIHRvIHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIGZhaWxlZEltYWdlQnVpbGRzVG9waWMoc2NvcGU/OiBDb25zdHJ1Y3QpIHtcbiAgICBzY29wZSA/Pz0gdGhpcztcbiAgICBjb25zdCB0b3BpYyA9IG5ldyBzbnMuVG9waWMoc2NvcGUsICdGYWlsZWQgUnVubmVyIEltYWdlIEJ1aWxkcycpO1xuICAgIGNvbnN0IHN0YWNrID0gY2RrLlN0YWNrLm9mKHNjb3BlKTtcbiAgICBjZGsuQXNwZWN0cy5vZihzdGFjaykuYWRkKG5ldyBDb2RlQnVpbGRJbWFnZUJ1aWxkZXJGYWlsZWRCdWlsZE5vdGlmaWVyKHRvcGljKSk7XG4gICAgY2RrLkFzcGVjdHMub2Yoc3RhY2spLmFkZChcbiAgICAgIG5ldyBBd3NJbWFnZUJ1aWxkZXJGYWlsZWRCdWlsZE5vdGlmaWVyKFxuICAgICAgICBBd3NJbWFnZUJ1aWxkZXJGYWlsZWRCdWlsZE5vdGlmaWVyLmNyZWF0ZUZpbHRlcmluZ1RvcGljKHNjb3BlLCB0b3BpYyksXG4gICAgICApLFxuICAgICk7XG4gICAgcmV0dXJuIHRvcGljO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgQ2xvdWRXYXRjaCBMb2dzIEluc2lnaHRzIHNhdmVkIHF1ZXJpZXMgdGhhdCBjYW4gYmUgdXNlZCB0byBkZWJ1ZyBpc3N1ZXMgd2l0aCB0aGUgcnVubmVycy5cbiAgICpcbiAgICogKiBcIldlYmhvb2sgZXJyb3JzXCIgaGVscHMgZGlhZ25vc2UgY29uZmlndXJhdGlvbiBpc3N1ZXMgd2l0aCBHaXRIdWIgaW50ZWdyYXRpb25cbiAgICogKiBcIklnbm9yZWQgd2ViaG9va1wiIGhlbHBzIHVuZGVyc3RhbmQgd2h5IHJ1bm5lcnMgYXJlbid0IHN0YXJ0ZWRcbiAgICogKiBcIklnbm9yZWQgam9icyBiYXNlZCBvbiBsYWJlbHNcIiBoZWxwcyBkZWJ1ZyBsYWJlbCBtYXRjaGluZyBpc3N1ZXNcbiAgICogKiBcIldlYmhvb2sgc3RhcnRlZCBydW5uZXJzXCIgaGVscHMgdW5kZXJzdGFuZCB3aGljaCBydW5uZXJzIHdlcmUgc3RhcnRlZFxuICAgKlxuICAgKiBAcGFyYW0gcHJlZml4IFByZWZpeCBmb3IgdGhlIHF1ZXJ5IGRlZmluaXRpb25zLiBEZWZhdWx0cyB0byBcIkdpdEh1YiBSdW5uZXJzXCIuXG4gICAqL1xuICBwdWJsaWMgY3JlYXRlTG9nc0luc2lnaHRzUXVlcmllcyhwcmVmaXggPSAnR2l0SHViIFJ1bm5lcnMnKSB7XG4gICAgbmV3IGxvZ3MuUXVlcnlEZWZpbml0aW9uKHRoaXMsICdXZWJob29rIGVycm9ycycsIHtcbiAgICAgIHF1ZXJ5RGVmaW5pdGlvbk5hbWU6IGAke3ByZWZpeH0vV2ViaG9vayBlcnJvcnNgLFxuICAgICAgbG9nR3JvdXBzOiBbdGhpcy53ZWJob29rLmhhbmRsZXIubG9nR3JvdXBdLFxuICAgICAgcXVlcnlTdHJpbmc6IG5ldyBsb2dzLlF1ZXJ5U3RyaW5nKHtcbiAgICAgICAgZmlsdGVyU3RhdGVtZW50czogW1xuICAgICAgICAgIGBzdHJjb250YWlucyhAbG9nU3RyZWFtLCBcIiR7dGhpcy53ZWJob29rLmhhbmRsZXIuZnVuY3Rpb25OYW1lfVwiKWAsXG4gICAgICAgICAgJ2xldmVsID0gXCJFUlJPUlwiJyxcbiAgICAgICAgXSxcbiAgICAgICAgc29ydDogJ0B0aW1lc3RhbXAgZGVzYycsXG4gICAgICAgIGxpbWl0OiAxMDAsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIG5ldyBsb2dzLlF1ZXJ5RGVmaW5pdGlvbih0aGlzLCAnT3JjaGVzdHJhdGlvbiBlcnJvcnMnLCB7XG4gICAgICBxdWVyeURlZmluaXRpb25OYW1lOiBgJHtwcmVmaXh9L09yY2hlc3RyYXRpb24gZXJyb3JzYCxcbiAgICAgIGxvZ0dyb3VwczogW3NpbmdsZXRvbkxvZ0dyb3VwKHRoaXMsIFNpbmdsZXRvbkxvZ1R5cGUuT1JDSEVTVFJBVE9SKV0sXG4gICAgICBxdWVyeVN0cmluZzogbmV3IGxvZ3MuUXVlcnlTdHJpbmcoe1xuICAgICAgICBmaWx0ZXJTdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgJ2xldmVsID0gXCJFUlJPUlwiJyxcbiAgICAgICAgXSxcbiAgICAgICAgc29ydDogJ0B0aW1lc3RhbXAgZGVzYycsXG4gICAgICAgIGxpbWl0OiAxMDAsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIG5ldyBsb2dzLlF1ZXJ5RGVmaW5pdGlvbih0aGlzLCAnUnVubmVyIGltYWdlIGJ1aWxkIGVycm9ycycsIHtcbiAgICAgIHF1ZXJ5RGVmaW5pdGlvbk5hbWU6IGAke3ByZWZpeH0vUnVubmVyIGltYWdlIGJ1aWxkIGVycm9yc2AsXG4gICAgICBsb2dHcm91cHM6IFtzaW5nbGV0b25Mb2dHcm91cCh0aGlzLCBTaW5nbGV0b25Mb2dUeXBlLlJVTk5FUl9JTUFHRV9CVUlMRCldLFxuICAgICAgcXVlcnlTdHJpbmc6IG5ldyBsb2dzLlF1ZXJ5U3RyaW5nKHtcbiAgICAgICAgZmlsdGVyU3RhdGVtZW50czogW1xuICAgICAgICAgICdzdHJjb250YWlucyhtZXNzYWdlLCBcImVycm9yXCIpIG9yIHN0cmNvbnRhaW5zKG1lc3NhZ2UsIFwiRVJST1JcIikgb3Igc3RyY29udGFpbnMobWVzc2FnZSwgXCJFcnJvclwiKSBvciBsZXZlbCA9IFwiRVJST1JcIicsXG4gICAgICAgIF0sXG4gICAgICAgIHNvcnQ6ICdAdGltZXN0YW1wIGRlc2MnLFxuICAgICAgICBsaW1pdDogMTAwLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBuZXcgbG9ncy5RdWVyeURlZmluaXRpb24odGhpcywgJ0lnbm9yZWQgd2ViaG9va3MnLCB7XG4gICAgICBxdWVyeURlZmluaXRpb25OYW1lOiBgJHtwcmVmaXh9L0lnbm9yZWQgd2ViaG9va3NgLFxuICAgICAgbG9nR3JvdXBzOiBbdGhpcy53ZWJob29rLmhhbmRsZXIubG9nR3JvdXBdLFxuICAgICAgcXVlcnlTdHJpbmc6IG5ldyBsb2dzLlF1ZXJ5U3RyaW5nKHtcbiAgICAgICAgZmllbGRzOiBbJ0B0aW1lc3RhbXAnLCAnbWVzc2FnZS5ub3RpY2UnXSxcbiAgICAgICAgZmlsdGVyU3RhdGVtZW50czogW1xuICAgICAgICAgIGBzdHJjb250YWlucyhAbG9nU3RyZWFtLCBcIiR7dGhpcy53ZWJob29rLmhhbmRsZXIuZnVuY3Rpb25OYW1lfVwiKWAsXG4gICAgICAgICAgJ3N0cmNvbnRhaW5zKG1lc3NhZ2Uubm90aWNlLCBcIklnbm9yaW5nXCIpJyxcbiAgICAgICAgXSxcbiAgICAgICAgc29ydDogJ0B0aW1lc3RhbXAgZGVzYycsXG4gICAgICAgIGxpbWl0OiAxMDAsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIG5ldyBsb2dzLlF1ZXJ5RGVmaW5pdGlvbih0aGlzLCAnSWdub3JlZCBqb2JzIGJhc2VkIG9uIGxhYmVscycsIHtcbiAgICAgIHF1ZXJ5RGVmaW5pdGlvbk5hbWU6IGAke3ByZWZpeH0vSWdub3JlZCBqb2JzIGJhc2VkIG9uIGxhYmVsc2AsXG4gICAgICBsb2dHcm91cHM6IFt0aGlzLndlYmhvb2suaGFuZGxlci5sb2dHcm91cF0sXG4gICAgICBxdWVyeVN0cmluZzogbmV3IGxvZ3MuUXVlcnlTdHJpbmcoe1xuICAgICAgICBmaWVsZHM6IFsnQHRpbWVzdGFtcCcsICdtZXNzYWdlLm5vdGljZSddLFxuICAgICAgICBmaWx0ZXJTdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgYHN0cmNvbnRhaW5zKEBsb2dTdHJlYW0sIFwiJHt0aGlzLndlYmhvb2suaGFuZGxlci5mdW5jdGlvbk5hbWV9XCIpYCxcbiAgICAgICAgICAnc3RyY29udGFpbnMobWVzc2FnZS5ub3RpY2UsIFwiSWdub3JpbmcgbGFiZWxzXCIpJyxcbiAgICAgICAgXSxcbiAgICAgICAgc29ydDogJ0B0aW1lc3RhbXAgZGVzYycsXG4gICAgICAgIGxpbWl0OiAxMDAsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIG5ldyBsb2dzLlF1ZXJ5RGVmaW5pdGlvbih0aGlzLCAnV2ViaG9vayBzdGFydGVkIHJ1bm5lcnMnLCB7XG4gICAgICBxdWVyeURlZmluaXRpb25OYW1lOiBgJHtwcmVmaXh9L1dlYmhvb2sgc3RhcnRlZCBydW5uZXJzYCxcbiAgICAgIGxvZ0dyb3VwczogW3RoaXMud2ViaG9vay5oYW5kbGVyLmxvZ0dyb3VwXSxcbiAgICAgIHF1ZXJ5U3RyaW5nOiBuZXcgbG9ncy5RdWVyeVN0cmluZyh7XG4gICAgICAgIGZpZWxkczogWydAdGltZXN0YW1wJywgJ21lc3NhZ2Uuc2ZuSW5wdXQuam9iVXJsJywgJ21lc3NhZ2Uuc2ZuSW5wdXQuam9iTGFiZWxzJywgJ21lc3NhZ2Uuc2ZuSW5wdXQubGFiZWxzJywgJ21lc3NhZ2Uuc2ZuSW5wdXQucHJvdmlkZXInXSxcbiAgICAgICAgZmlsdGVyU3RhdGVtZW50czogW1xuICAgICAgICAgIGBzdHJjb250YWlucyhAbG9nU3RyZWFtLCBcIiR7dGhpcy53ZWJob29rLmhhbmRsZXIuZnVuY3Rpb25OYW1lfVwiKWAsXG4gICAgICAgICAgJ21lc3NhZ2Uuc2ZuSW5wdXQuam9iVXJsIGxpa2UgL2h0dHAuKi8nLFxuICAgICAgICBdLFxuICAgICAgICBzb3J0OiAnQHRpbWVzdGFtcCBkZXNjJyxcbiAgICAgICAgbGltaXQ6IDEwMCxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgbmV3IGxvZ3MuUXVlcnlEZWZpbml0aW9uKHRoaXMsICdXZWJob29rIHJlZGVsaXZlcmllcycsIHtcbiAgICAgIHF1ZXJ5RGVmaW5pdGlvbk5hbWU6IGAke3ByZWZpeH0vV2ViaG9vayByZWRlbGl2ZXJpZXNgLFxuICAgICAgbG9nR3JvdXBzOiBbdGhpcy5yZWRlbGl2ZXJlci5oYW5kbGVyLmxvZ0dyb3VwXSxcbiAgICAgIHF1ZXJ5U3RyaW5nOiBuZXcgbG9ncy5RdWVyeVN0cmluZyh7XG4gICAgICAgIGZpZWxkczogWydAdGltZXN0YW1wJywgJ21lc3NhZ2Uubm90aWNlJywgJ21lc3NhZ2UuZGVsaXZlcnlJZCcsICdtZXNzYWdlLmd1aWQnXSxcbiAgICAgICAgZmlsdGVyU3RhdGVtZW50czogW1xuICAgICAgICAgICdpc1ByZXNlbnQobWVzc2FnZS5kZWxpdmVyeUlkKScsXG4gICAgICAgIF0sXG4gICAgICAgIHNvcnQ6ICdAdGltZXN0YW1wIGRlc2MnLFxuICAgICAgICBsaW1pdDogMTAwLFxuICAgICAgfSksXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==