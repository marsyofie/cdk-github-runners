"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LambdaRunner = exports.LambdaRunnerProvider = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const path = require("path");
const cdk = require("aws-cdk-lib");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const common_1 = require("./common");
const update_lambda_function_1 = require("./update-lambda-function");
const image_builders_1 = require("../image-builders");
const utils_1 = require("../utils");
/**
 * GitHub Actions runner provider using Lambda to execute jobs.
 *
 * Creates a Docker-based function that gets executed for each job.
 *
 * This construct is not meant to be used by itself. It should be passed in the providers property for GitHubRunners.
 */
class LambdaRunnerProvider extends common_1.BaseProvider {
    /**
     * Create new image builder that builds Lambda specific runner images.
     *
     * You can customize the OS, architecture, VPC, subnet, security groups, etc. by passing in props.
     *
     * You can add components to the image builder by calling `imageBuilder.addComponent()`.
     *
     * The default OS is Amazon Linux 2023 running on x64 architecture.
     *
     * Included components:
     *  * `RunnerImageComponent.requiredPackages()`
     *  * `RunnerImageComponent.runnerUser()`
     *  * `RunnerImageComponent.git()`
     *  * `RunnerImageComponent.githubCli()`
     *  * `RunnerImageComponent.awsCli()`
     *  * `RunnerImageComponent.githubRunner()`
     *  * `RunnerImageComponent.lambdaEntrypoint()`
     */
    static imageBuilder(scope, id, props) {
        return image_builders_1.RunnerImageBuilder.new(scope, id, {
            os: common_1.Os.LINUX_AMAZON_2023,
            architecture: common_1.Architecture.X86_64,
            components: [
                image_builders_1.RunnerImageComponent.requiredPackages(),
                image_builders_1.RunnerImageComponent.runnerUser(),
                image_builders_1.RunnerImageComponent.git(),
                image_builders_1.RunnerImageComponent.githubCli(),
                image_builders_1.RunnerImageComponent.awsCli(),
                image_builders_1.RunnerImageComponent.githubRunner(props?.runnerVersion ?? common_1.RunnerVersion.latest()),
                image_builders_1.RunnerImageComponent.lambdaEntrypoint(),
            ],
            ...props,
        });
    }
    constructor(scope, id, props) {
        super(scope, id, props);
        this.retryableErrors = [
            'Lambda.LambdaException',
            'Lambda.Ec2ThrottledException',
            'Lambda.Ec2UnexpectedException',
            'Lambda.EniLimitReachedException',
            'Lambda.TooManyRequestsException',
        ];
        this.labels = this.labelsFromProperties('lambda', props?.label, props?.labels);
        this.group = props?.group;
        this.defaultLabels = props?.defaultLabels ?? true;
        this.vpc = props?.vpc;
        this.securityGroups = props?.securityGroup ? [props.securityGroup] : props?.securityGroups;
        const imageBuilder = props?.imageBuilder ?? LambdaRunnerProvider.imageBuilder(this, 'Image Builder');
        const image = this.image = imageBuilder.bindDockerImage();
        let architecture;
        if (image.os.isIn(common_1.Os._ALL_LINUX_VERSIONS)) {
            if (image.architecture.is(common_1.Architecture.X86_64)) {
                architecture = aws_cdk_lib_1.aws_lambda.Architecture.X86_64;
            }
            if (image.architecture.is(common_1.Architecture.ARM64)) {
                architecture = aws_cdk_lib_1.aws_lambda.Architecture.ARM_64;
            }
        }
        if (!architecture) {
            throw new Error(`Unable to find supported Lambda architecture for ${image.os.name}/${image.architecture.name}`);
        }
        if (!image._dependable) {
            // AWS Image Builder can't get us dependable images and there is no point in using it anyway. CodeBuild is so much faster.
            // This may change if Lambda starts supporting Windows images. Then we would need AWS Image Builder.
            cdk.Annotations.of(this).addError('Lambda provider can only work with images built by CodeBuild and not AWS Image Builder. `waitOnDeploy: false` is also not supported.');
        }
        // get image digest and make sure to get it every time the lambda function might be updated
        // pass all variables that may change and cause a function update
        // if we don't get the latest digest, the update may fail as a new image was already built outside the stack on a schedule
        // we automatically delete old images, so we must always get the latest digest
        const imageDigest = this.imageDigest(image, {
            version: 1, // bump this for any non-user changes like description or defaults
            labels: this.labels,
            architecture: architecture.name,
            vpc: this.vpc?.vpcId,
            securityGroups: this.securityGroups?.map(sg => sg.securityGroupId),
            vpcSubnets: props?.subnetSelection?.subnets?.map(s => s.subnetId),
            timeout: props?.timeout?.toSeconds(),
            memorySize: props?.memorySize,
            ephemeralStorageSize: props?.ephemeralStorageSize?.toKibibytes(),
            logRetention: props?.logRetention?.toFixed(),
            // update on image build too to avoid conflict of the scheduled updater and any other CDK updates like VPC
            // this also helps with rollbacks as it will always get the right digest and prevent rollbacks using deleted images from failing
            dependable: image._dependable,
        });
        this.logGroup = new aws_cdk_lib_1.aws_logs.LogGroup(this, 'Log', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: props?.logRetention ?? aws_logs_1.RetentionDays.ONE_MONTH,
        });
        this.function = new aws_cdk_lib_1.aws_lambda.DockerImageFunction(this, 'Function', {
            description: `GitHub Actions runner for labels ${this.labels}`,
            // CDK requires "sha256:" literal prefix -- https://github.com/aws/aws-cdk/blob/ba91ca45ad759ab5db6da17a62333e2bc11e1075/packages/%40aws-cdk/aws-ecr/lib/repository.ts#L184
            code: aws_cdk_lib_1.aws_lambda.DockerImageCode.fromEcr(image.imageRepository, { tagOrDigest: `sha256:${imageDigest}` }),
            architecture,
            vpc: this.vpc,
            securityGroups: this.securityGroups,
            vpcSubnets: props?.subnetSelection,
            timeout: props?.timeout || cdk.Duration.minutes(15),
            memorySize: props?.memorySize || 2048,
            ephemeralStorageSize: props?.ephemeralStorageSize || cdk.Size.gibibytes(10),
            logGroup: this.logGroup,
        });
        this.grantPrincipal = this.function.grantPrincipal;
        this.addImageUpdater(image);
    }
    /**
     * The network connections associated with this resource.
     */
    get connections() {
        return this.function.connections;
    }
    /**
     * Generate step function task(s) to start a new runner.
     *
     * Called by GithubRunners and shouldn't be called manually.
     *
     * @param parameters workflow job details
     */
    getStepFunctionTask(parameters) {
        return new aws_cdk_lib_1.aws_stepfunctions_tasks.LambdaInvoke(this, 'State', {
            stateName: (0, common_1.generateStateName)(this),
            lambdaFunction: this.function,
            payload: aws_cdk_lib_1.aws_stepfunctions.TaskInput.fromObject({
                token: parameters.runnerTokenPath,
                runnerName: parameters.runnerNamePath,
                label: parameters.labelsPath,
                githubDomain: parameters.githubDomainPath,
                owner: parameters.ownerPath,
                repo: parameters.repoPath,
                registrationUrl: parameters.registrationUrl,
                group: this.group ? `--runnergroup ${this.group}` : '',
                defaultLabels: this.defaultLabels ? '' : '--no-default-labels',
            }),
        });
    }
    addImageUpdater(image) {
        // Lambda needs to be pointing to a specific image digest and not just a tag.
        // Whenever we update the tag to a new digest, we need to update the lambda.
        const updater = (0, utils_1.singletonLambda)(update_lambda_function_1.UpdateLambdaFunction, this, 'update-lambda', {
            description: 'Function that updates a GitHub Actions runner function with the latest image digest after the image has been rebuilt',
            timeout: cdk.Duration.minutes(15),
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.RUNNER_IMAGE_BUILD),
            loggingFormat: aws_cdk_lib_1.aws_lambda.LoggingFormat.JSON,
        });
        updater.addToRolePolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['lambda:UpdateFunctionCode'],
            resources: [this.function.functionArn],
        }));
        let lambdaTarget = new aws_cdk_lib_1.aws_events_targets.LambdaFunction(updater, {
            event: aws_cdk_lib_1.aws_events.RuleTargetInput.fromObject({
                lambdaName: this.function.functionName,
                repositoryUri: image.imageRepository.repositoryUri,
                repositoryTag: image.imageTag,
            }),
        });
        const rule = image.imageRepository.onEvent('Push rule', {
            crossStackScope: this, // allow provider and image builder to be in different stacks
            description: 'Update GitHub Actions runner Lambda on ECR image push',
            eventPattern: {
                detailType: ['ECR Image Action'],
                detail: {
                    'action-type': ['PUSH'],
                    'repository-name': [image.imageRepository.repositoryName],
                    'image-tag': [image.imageTag],
                    'result': ['SUCCESS'],
                },
            },
            target: lambdaTarget,
        });
        // the event never triggers without this - not sure why
        rule.node.defaultChild.addDeletionOverride('Properties.EventPattern.resources');
    }
    grantStateMachine(_) {
    }
    status(statusFunctionRole) {
        this.image.imageRepository.grant(statusFunctionRole, 'ecr:DescribeImages');
        return {
            type: this.constructor.name,
            labels: this.labels,
            constructPath: this.node.path,
            vpcArn: this.vpc?.vpcArn,
            securityGroups: this.securityGroups?.map(sg => sg.securityGroupId),
            roleArn: this.function.role?.roleArn,
            logGroup: this.function.logGroup.logGroupName,
            image: {
                imageRepository: this.image.imageRepository.repositoryUri,
                imageTag: this.image.imageTag,
                imageBuilderLogGroup: this.image.logGroup?.logGroupName,
            },
        };
    }
    imageDigest(image, variableSettings) {
        // describe ECR image to get its digest
        // the physical id is random so the resource always runs and always gets the latest digest, even if a scheduled build replaced the stack image
        const reader = new aws_cdk_lib_1.custom_resources.AwsCustomResource(this, 'Image Digest Reader', {
            onCreate: {
                service: 'ECR',
                action: 'describeImages',
                parameters: {
                    repositoryName: image.imageRepository.repositoryName,
                    imageIds: [
                        {
                            imageTag: image.imageTag,
                        },
                    ],
                },
                physicalResourceId: aws_cdk_lib_1.custom_resources.PhysicalResourceId.of('ImageDigest'),
            },
            onUpdate: {
                service: 'ECR',
                action: 'describeImages',
                parameters: {
                    repositoryName: image.imageRepository.repositoryName,
                    imageIds: [
                        {
                            imageTag: image.imageTag,
                        },
                    ],
                },
                physicalResourceId: aws_cdk_lib_1.custom_resources.PhysicalResourceId.of('ImageDigest'),
            },
            onDelete: {
                // this will NOT be called thanks to RemovalPolicy.RETAIN below
                // we only use this to force the custom resource to be called again and get a new digest
                service: 'fake',
                action: 'fake',
                parameters: variableSettings,
            },
            policy: aws_cdk_lib_1.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [image.imageRepository.repositoryArn],
            }),
            resourceType: 'Custom::EcrImageDigest',
            installLatestAwsSdk: false, // no need and it takes 60 seconds
            logGroup: (0, utils_1.singletonLogGroup)(this, utils_1.SingletonLogType.RUNNER_IMAGE_BUILD),
        });
        // mark this resource as retainable, as there is nothing to do on delete
        const res = reader.node.tryFindChild('Resource');
        if (res) {
            // don't actually call the fake onDelete above
            res.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        }
        else {
            throw new Error('Resource not found in AwsCustomResource. Report this bug at https://github.com/CloudSnorkel/cdk-github-runners/issues.');
        }
        // return only the digest because CDK expects 'sha256:' literal above
        return cdk.Fn.split(':', reader.getResponseField('imageDetails.0.imageDigest'), 2)[1];
    }
}
exports.LambdaRunnerProvider = LambdaRunnerProvider;
_a = JSII_RTTI_SYMBOL_1;
LambdaRunnerProvider[_a] = { fqn: "@cloudsnorkel/cdk-github-runners.LambdaRunnerProvider", version: "0.0.0" };
/**
 * Path to Dockerfile for Linux x64 with all the requirement for Lambda runner. Use this Dockerfile unless you need to customize it further than allowed by hooks.
 *
 * Available build arguments that can be set in the image builder:
 * * `BASE_IMAGE` sets the `FROM` line. This should be similar to public.ecr.aws/lambda/nodejs:14.
 * * `EXTRA_PACKAGES` can be used to install additional packages.
 *
 * @deprecated Use `imageBuilder()` instead.
 */
LambdaRunnerProvider.LINUX_X64_DOCKERFILE_PATH = path.join(__dirname, '..', '..', 'assets', 'docker-images', 'lambda', 'linux-x64');
/**
 * Path to Dockerfile for Linux ARM64 with all the requirement for Lambda runner. Use this Dockerfile unless you need to customize it further than allowed by hooks.
 *
 * Available build arguments that can be set in the image builder:
 * * `BASE_IMAGE` sets the `FROM` line. This should be similar to public.ecr.aws/lambda/nodejs:14.
 * * `EXTRA_PACKAGES` can be used to install additional packages.
 *
 * @deprecated Use `imageBuilder()` instead.
 */
LambdaRunnerProvider.LINUX_ARM64_DOCKERFILE_PATH = path.join(__dirname, '..', '..', 'assets', 'docker-images', 'lambda', 'linux-arm64');
/**
 * @deprecated use {@link LambdaRunnerProvider}
 */
class LambdaRunner extends LambdaRunnerProvider {
}
exports.LambdaRunner = LambdaRunner;
_b = JSII_RTTI_SYMBOL_1;
LambdaRunner[_b] = { fqn: "@cloudsnorkel/cdk-github-runners.LambdaRunner", version: "0.0.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFtYmRhLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Byb3ZpZGVycy9sYW1iZGEudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2QkFBNkI7QUFDN0IsbUNBQW1DO0FBQ25DLDZDQVVxQjtBQUNyQixtREFBcUQ7QUFFckQscUNBV2tCO0FBQ2xCLHFFQUFnRTtBQUNoRSxzREFBMkg7QUFDM0gsb0NBQWdGO0FBd0doRjs7Ozs7O0dBTUc7QUFDSCxNQUFhLG9CQUFxQixTQUFRLHFCQUFZO0lBdUJwRDs7Ozs7Ozs7Ozs7Ozs7Ozs7T0FpQkc7SUFDSSxNQUFNLENBQUMsWUFBWSxDQUFDLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQStCO1FBQ3RGLE9BQU8sbUNBQWtCLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUU7WUFDdkMsRUFBRSxFQUFFLFdBQUUsQ0FBQyxpQkFBaUI7WUFDeEIsWUFBWSxFQUFFLHFCQUFZLENBQUMsTUFBTTtZQUNqQyxVQUFVLEVBQUU7Z0JBQ1YscUNBQW9CLENBQUMsZ0JBQWdCLEVBQUU7Z0JBQ3ZDLHFDQUFvQixDQUFDLFVBQVUsRUFBRTtnQkFDakMscUNBQW9CLENBQUMsR0FBRyxFQUFFO2dCQUMxQixxQ0FBb0IsQ0FBQyxTQUFTLEVBQUU7Z0JBQ2hDLHFDQUFvQixDQUFDLE1BQU0sRUFBRTtnQkFDN0IscUNBQW9CLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxhQUFhLElBQUksc0JBQWEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDakYscUNBQW9CLENBQUMsZ0JBQWdCLEVBQUU7YUFDeEM7WUFDRCxHQUFHLEtBQUs7U0FDVCxDQUFDLENBQUM7SUFDTCxDQUFDO0lBNENELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFkakIsb0JBQWUsR0FBRztZQUN6Qix3QkFBd0I7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Q0FBa0M7WUFDOUQsUUFBUSxFQUFFLElBQUEseUJBQWlCLEVBQUMsSUFBSSxFQUFFLHdCQUFnQixDQUFDLGtCQUFrQixDQUFDO1NBQ3ZFLENBQUMsQ0FBQztRQUVILHdFQUF3RTtRQUN4RSxNQUFNLEdBQUcsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxVQUFVLENBQW1DLENBQUM7UUFDbkYsSUFBSSxHQUFHLEVBQUUsQ0FBQztZQUNSLDhDQUE4QztZQUM5QyxHQUFHLENBQUMsa0JBQWtCLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUNuRCxDQUFDO2FBQU0sQ0FBQztZQUNOLE1BQU0sSUFBSSxLQUFLLENBQUMsd0hBQXdILENBQUMsQ0FBQztRQUM1SSxDQUFDO1FBRUQscUVBQXFFO1FBQ3JFLE9BQU8sR0FBRyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyw0QkFBNEIsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3hGLENBQUM7O0FBalZILG9EQWtWQzs7O0FBalZDOzs7Ozs7OztHQVFHO0FBQ29CLDhDQUF5QixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsV0FBVyxDQUFDLEFBQXJGLENBQXNGO0FBRXRJOzs7Ozs7OztHQVFHO0FBQ29CLGdEQUEyQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsYUFBYSxDQUFDLEFBQXZGLENBQXdGO0FBK1Q1STs7R0FFRztBQUNILE1BQWEsWUFBYSxTQUFRLG9CQUFvQjs7QUFBdEQsb0NBQ0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7XG4gIGF3c19lYzIgYXMgZWMyLFxuICBhd3NfZXZlbnRzIGFzIGV2ZW50cyxcbiAgYXdzX2V2ZW50c190YXJnZXRzIGFzIGV2ZW50c190YXJnZXRzLFxuICBhd3NfaWFtIGFzIGlhbSxcbiAgYXdzX2xhbWJkYSBhcyBsYW1iZGEsXG4gIGF3c19sb2dzIGFzIGxvZ3MsXG4gIGF3c19zdGVwZnVuY3Rpb25zIGFzIHN0ZXBmdW5jdGlvbnMsXG4gIGF3c19zdGVwZnVuY3Rpb25zX3Rhc2tzIGFzIHN0ZXBmdW5jdGlvbnNfdGFza3MsXG4gIGN1c3RvbV9yZXNvdXJjZXMgYXMgY3IsXG59IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFJldGVudGlvbkRheXMgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7XG4gIEFyY2hpdGVjdHVyZSxcbiAgQmFzZVByb3ZpZGVyLFxuICBJUnVubmVyUHJvdmlkZXIsXG4gIElSdW5uZXJQcm92aWRlclN0YXR1cyxcbiAgT3MsXG4gIFJ1bm5lckltYWdlLFxuICBSdW5uZXJQcm92aWRlclByb3BzLFxuICBSdW5uZXJSdW50aW1lUGFyYW1ldGVycyxcbiAgUnVubmVyVmVyc2lvbixcbiAgZ2VuZXJhdGVTdGF0ZU5hbWUsXG59IGZyb20gJy4vY29tbW9uJztcbmltcG9ydCB7IFVwZGF0ZUxhbWJkYUZ1bmN0aW9uIH0gZnJvbSAnLi91cGRhdGUtbGFtYmRhLWZ1bmN0aW9uJztcbmltcG9ydCB7IElSdW5uZXJJbWFnZUJ1aWxkZXIsIFJ1bm5lckltYWdlQnVpbGRlciwgUnVubmVySW1hZ2VCdWlsZGVyUHJvcHMsIFJ1bm5lckltYWdlQ29tcG9uZW50IH0gZnJvbSAnLi4vaW1hZ2UtYnVpbGRlcnMnO1xuaW1wb3J0IHsgc2luZ2xldG9uTGFtYmRhLCBzaW5nbGV0b25Mb2dHcm91cCwgU2luZ2xldG9uTG9nVHlwZSB9IGZyb20gJy4uL3V0aWxzJztcblxuZXhwb3J0IGludGVyZmFjZSBMYW1iZGFSdW5uZXJQcm92aWRlclByb3BzIGV4dGVuZHMgUnVubmVyUHJvdmlkZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBSdW5uZXIgaW1hZ2UgYnVpbGRlciB1c2VkIHRvIGJ1aWxkIERvY2tlciBpbWFnZXMgY29udGFpbmluZyBHaXRIdWIgUnVubmVyIGFuZCBhbGwgcmVxdWlyZW1lbnRzLlxuICAgKlxuICAgKiBUaGUgaW1hZ2UgYnVpbGRlciBtdXN0IGNvbnRhaW4gdGhlIHtAbGluayBSdW5uZXJJbWFnZUNvbXBvbmVudC5sYW1iZGFFbnRyeXBvaW50fSBjb21wb25lbnQuXG4gICAqXG4gICAqIFRoZSBpbWFnZSBidWlsZGVyIGRldGVybWluZXMgdGhlIE9TIGFuZCBhcmNoaXRlY3R1cmUgb2YgdGhlIHJ1bm5lci5cbiAgICpcbiAgICogQGRlZmF1bHQgTGFtYmRhUnVubmVyUHJvdmlkZXIuaW1hZ2VCdWlsZGVyKClcbiAgICovXG4gIHJlYWRvbmx5IGltYWdlQnVpbGRlcj86IElSdW5uZXJJbWFnZUJ1aWxkZXI7XG5cbiAgLyoqXG4gICAqIEdpdEh1YiBBY3Rpb25zIGxhYmVsIHVzZWQgZm9yIHRoaXMgcHJvdmlkZXIuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKiBAZGVwcmVjYXRlZCB1c2Uge0BsaW5rIGxhYmVsc30gaW5zdGVhZFxuICAgKi9cbiAgcmVhZG9ubHkgbGFiZWw/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEdpdEh1YiBBY3Rpb25zIGxhYmVscyB1c2VkIGZvciB0aGlzIHByb3ZpZGVyLlxuICAgKlxuICAgKiBUaGVzZSBsYWJlbHMgYXJlIHVzZWQgdG8gaWRlbnRpZnkgd2hpY2ggcHJvdmlkZXIgc2hvdWxkIHNwYXduIGEgbmV3IG9uLWRlbWFuZCBydW5uZXIuIEV2ZXJ5IGpvYiBzZW5kcyBhIHdlYmhvb2sgd2l0aCB0aGUgbGFiZWxzIGl0J3MgbG9va2luZyBmb3JcbiAgICogYmFzZWQgb24gcnVucy1vbi4gV2UgbWF0Y2ggdGhlIGxhYmVscyBmcm9tIHRoZSB3ZWJob29rIHdpdGggdGhlIGxhYmVscyBzcGVjaWZpZWQgaGVyZS4gSWYgYWxsIHRoZSBsYWJlbHMgc3BlY2lmaWVkIGhlcmUgYXJlIHByZXNlbnQgaW4gdGhlXG4gICAqIGpvYidzIGxhYmVscywgdGhpcyBwcm92aWRlciB3aWxsIGJlIGNob3NlbiBhbmQgc3Bhd24gYSBuZXcgcnVubmVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCBbJ2xhbWJkYSddXG4gICAqL1xuICByZWFkb25seSBsYWJlbHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogR2l0SHViIEFjdGlvbnMgcnVubmVyIGdyb3VwIG5hbWUuXG4gICAqXG4gICAqIElmIHNwZWNpZmllZCwgdGhlIHJ1bm5lciB3aWxsIGJlIHJlZ2lzdGVyZWQgd2l0aCB0aGlzIGdyb3VwIG5hbWUuIFNldHRpbmcgYSBydW5uZXIgZ3JvdXAgY2FuIGhlbHAgbWFuYWdpbmcgYWNjZXNzIHRvIHNlbGYtaG9zdGVkIHJ1bm5lcnMuIEl0XG4gICAqIHJlcXVpcmVzIGEgcGFpZCBHaXRIdWIgYWNjb3VudC5cbiAgICpcbiAgICogVGhlIGdyb3VwIG11c3QgZXhpc3Qgb3IgdGhlIHJ1bm5lciB3aWxsIG5vdCBzdGFydC5cbiAgICpcbiAgICogVXNlcnMgd2lsbCBzdGlsbCBiZSBhYmxlIHRvIHRyaWdnZXIgdGhpcyBydW5uZXIgd2l0aCB0aGUgY29ycmVjdCBsYWJlbHMuIEJ1dCB0aGUgcnVubmVyIHdpbGwgb25seSBiZSBhYmxlIHRvIHJ1biBqb2JzIGZyb20gcmVwb3MgYWxsb3dlZCB0byB1c2UgdGhlIGdyb3VwLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGdyb3VwPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYW1vdW50IG9mIG1lbW9yeSwgaW4gTUIsIHRoYXQgaXMgYWxsb2NhdGVkIHRvIHlvdXIgTGFtYmRhIGZ1bmN0aW9uLlxuICAgKiBMYW1iZGEgdXNlcyB0aGlzIHZhbHVlIHRvIHByb3BvcnRpb25hbGx5IGFsbG9jYXRlIHRoZSBhbW91bnQgb2YgQ1BVXG4gICAqIHBvd2VyLiBGb3IgbW9yZSBpbmZvcm1hdGlvbiwgc2VlIFJlc291cmNlIE1vZGVsIGluIHRoZSBBV1MgTGFtYmRhXG4gICAqIERldmVsb3BlciBHdWlkZS5cbiAgICpcbiAgICogQGRlZmF1bHQgMjA0OFxuICAgKi9cbiAgcmVhZG9ubHkgbWVtb3J5U2l6ZT86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhlIHNpemUgb2YgdGhlIGZ1bmN0aW9u4oCZcyAvdG1wIGRpcmVjdG9yeSBpbiBNaUIuXG4gICAqXG4gICAqIEBkZWZhdWx0IDEwIEdpQlxuICAgKi9cbiAgcmVhZG9ubHkgZXBoZW1lcmFsU3RvcmFnZVNpemU/OiBjZGsuU2l6ZTtcblxuICAvKipcbiAgICogVGhlIGZ1bmN0aW9uIGV4ZWN1dGlvbiB0aW1lIChpbiBzZWNvbmRzKSBhZnRlciB3aGljaCBMYW1iZGEgdGVybWluYXRlc1xuICAgKiB0aGUgZnVuY3Rpb24uIEJlY2F1c2UgdGhlIGV4ZWN1dGlvbiB0aW1lIGFmZmVjdHMgY29zdCwgc2V0IHRoaXMgdmFsdWVcbiAgICogYmFzZWQgb24gdGhlIGZ1bmN0aW9uJ3MgZXhwZWN0ZWQgZXhlY3V0aW9uIHRpbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLm1pbnV0ZXMoMTUpXG4gICAqL1xuICByZWFkb25seSB0aW1lb3V0PzogY2RrLkR1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBWUEMgdG8gbGF1bmNoIHRoZSBydW5uZXJzIGluLlxuICAgKlxuICAgKiBAZGVmYXVsdCBubyBWUENcbiAgICovXG4gIHJlYWRvbmx5IHZwYz86IGVjMi5JVnBjO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cCB0byBhc3NpZ24gdG8gdGhpcyBpbnN0YW5jZS5cbiAgICpcbiAgICogQGRlZmF1bHQgcHVibGljIGxhbWJkYSB3aXRoIG5vIHNlY3VyaXR5IGdyb3VwXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIHVzZSB7QGxpbmsgc2VjdXJpdHlHcm91cHN9XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eUdyb3VwPzogZWMyLklTZWN1cml0eUdyb3VwO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cHMgdG8gYXNzaWduIHRvIHRoaXMgaW5zdGFuY2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IHB1YmxpYyBsYW1iZGEgd2l0aCBubyBzZWN1cml0eSBncm91cFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcblxuICAvKipcbiAgICogV2hlcmUgdG8gcGxhY2UgdGhlIG5ldHdvcmsgaW50ZXJmYWNlcyB3aXRoaW4gdGhlIFZQQy5cbiAgICpcbiAgICogQGRlZmF1bHQgbm8gc3VibmV0XG4gICAqL1xuICByZWFkb25seSBzdWJuZXRTZWxlY3Rpb24/OiBlYzIuU3VibmV0U2VsZWN0aW9uO1xufVxuXG4vKipcbiAqIEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBwcm92aWRlciB1c2luZyBMYW1iZGEgdG8gZXhlY3V0ZSBqb2JzLlxuICpcbiAqIENyZWF0ZXMgYSBEb2NrZXItYmFzZWQgZnVuY3Rpb24gdGhhdCBnZXRzIGV4ZWN1dGVkIGZvciBlYWNoIGpvYi5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBub3QgbWVhbnQgdG8gYmUgdXNlZCBieSBpdHNlbGYuIEl0IHNob3VsZCBiZSBwYXNzZWQgaW4gdGhlIHByb3ZpZGVycyBwcm9wZXJ0eSBmb3IgR2l0SHViUnVubmVycy5cbiAqL1xuZXhwb3J0IGNsYXNzIExhbWJkYVJ1bm5lclByb3ZpZGVyIGV4dGVuZHMgQmFzZVByb3ZpZGVyIGltcGxlbWVudHMgSVJ1bm5lclByb3ZpZGVyIHtcbiAgLyoqXG4gICAqIFBhdGggdG8gRG9ja2VyZmlsZSBmb3IgTGludXggeDY0IHdpdGggYWxsIHRoZSByZXF1aXJlbWVudCBmb3IgTGFtYmRhIHJ1bm5lci4gVXNlIHRoaXMgRG9ja2VyZmlsZSB1bmxlc3MgeW91IG5lZWQgdG8gY3VzdG9taXplIGl0IGZ1cnRoZXIgdGhhbiBhbGxvd2VkIGJ5IGhvb2tzLlxuICAgKlxuICAgKiBBdmFpbGFibGUgYnVpbGQgYXJndW1lbnRzIHRoYXQgY2FuIGJlIHNldCBpbiB0aGUgaW1hZ2UgYnVpbGRlcjpcbiAgICogKiBgQkFTRV9JTUFHRWAgc2V0cyB0aGUgYEZST01gIGxpbmUuIFRoaXMgc2hvdWxkIGJlIHNpbWlsYXIgdG8gcHVibGljLmVjci5hd3MvbGFtYmRhL25vZGVqczoxNC5cbiAgICogKiBgRVhUUkFfUEFDS0FHRVNgIGNhbiBiZSB1c2VkIHRvIGluc3RhbGwgYWRkaXRpb25hbCBwYWNrYWdlcy5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBpbWFnZUJ1aWxkZXIoKWAgaW5zdGVhZC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgTElOVVhfWDY0X0RPQ0tFUkZJTEVfUEFUSCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdhc3NldHMnLCAnZG9ja2VyLWltYWdlcycsICdsYW1iZGEnLCAnbGludXgteDY0Jyk7XG5cbiAgLyoqXG4gICAqIFBhdGggdG8gRG9ja2VyZmlsZSBmb3IgTGludXggQVJNNjQgd2l0aCBhbGwgdGhlIHJlcXVpcmVtZW50IGZvciBMYW1iZGEgcnVubmVyLiBVc2UgdGhpcyBEb2NrZXJmaWxlIHVubGVzcyB5b3UgbmVlZCB0byBjdXN0b21pemUgaXQgZnVydGhlciB0aGFuIGFsbG93ZWQgYnkgaG9va3MuXG4gICAqXG4gICAqIEF2YWlsYWJsZSBidWlsZCBhcmd1bWVudHMgdGhhdCBjYW4gYmUgc2V0IGluIHRoZSBpbWFnZSBidWlsZGVyOlxuICAgKiAqIGBCQVNFX0lNQUdFYCBzZXRzIHRoZSBgRlJPTWAgbGluZS4gVGhpcyBzaG91bGQgYmUgc2ltaWxhciB0byBwdWJsaWMuZWNyLmF3cy9sYW1iZGEvbm9kZWpzOjE0LlxuICAgKiAqIGBFWFRSQV9QQUNLQUdFU2AgY2FuIGJlIHVzZWQgdG8gaW5zdGFsbCBhZGRpdGlvbmFsIHBhY2thZ2VzLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgYGltYWdlQnVpbGRlcigpYCBpbnN0ZWFkLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyByZWFkb25seSBMSU5VWF9BUk02NF9ET0NLRVJGSUxFX1BBVEggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnLi4nLCAnYXNzZXRzJywgJ2RvY2tlci1pbWFnZXMnLCAnbGFtYmRhJywgJ2xpbnV4LWFybTY0Jyk7XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBuZXcgaW1hZ2UgYnVpbGRlciB0aGF0IGJ1aWxkcyBMYW1iZGEgc3BlY2lmaWMgcnVubmVyIGltYWdlcy5cbiAgICpcbiAgICogWW91IGNhbiBjdXN0b21pemUgdGhlIE9TLCBhcmNoaXRlY3R1cmUsIFZQQywgc3VibmV0LCBzZWN1cml0eSBncm91cHMsIGV0Yy4gYnkgcGFzc2luZyBpbiBwcm9wcy5cbiAgICpcbiAgICogWW91IGNhbiBhZGQgY29tcG9uZW50cyB0byB0aGUgaW1hZ2UgYnVpbGRlciBieSBjYWxsaW5nIGBpbWFnZUJ1aWxkZXIuYWRkQ29tcG9uZW50KClgLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBPUyBpcyBBbWF6b24gTGludXggMjAyMyBydW5uaW5nIG9uIHg2NCBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEluY2x1ZGVkIGNvbXBvbmVudHM6XG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5yZXF1aXJlZFBhY2thZ2VzKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5ydW5uZXJVc2VyKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXQoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YkNsaSgpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuYXdzQ2xpKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXRodWJSdW5uZXIoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmxhbWJkYUVudHJ5cG9pbnQoKWBcbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgaW1hZ2VCdWlsZGVyKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogUnVubmVySW1hZ2VCdWlsZGVyUHJvcHMpIHtcbiAgICByZXR1cm4gUnVubmVySW1hZ2VCdWlsZGVyLm5ldyhzY29wZSwgaWQsIHtcbiAgICAgIG9zOiBPcy5MSU5VWF9BTUFaT05fMjAyMyxcbiAgICAgIGFyY2hpdGVjdHVyZTogQXJjaGl0ZWN0dXJlLlg4Nl82NCxcbiAgICAgIGNvbXBvbmVudHM6IFtcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQucmVxdWlyZWRQYWNrYWdlcygpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5ydW5uZXJVc2VyKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdCgpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXRodWJDbGkoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuYXdzQ2xpKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YlJ1bm5lcihwcm9wcz8ucnVubmVyVmVyc2lvbiA/PyBSdW5uZXJWZXJzaW9uLmxhdGVzdCgpKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQubGFtYmRhRW50cnlwb2ludCgpLFxuICAgICAgXSxcbiAgICAgIC4uLnByb3BzLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBmdW5jdGlvbiBob3N0aW5nIHRoZSBHaXRIdWIgcnVubmVyLlxuICAgKi9cbiAgcmVhZG9ubHkgZnVuY3Rpb246IGxhbWJkYS5GdW5jdGlvbjtcblxuICAvKipcbiAgICogTGFiZWxzIGFzc29jaWF0ZWQgd2l0aCB0aGlzIHByb3ZpZGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgbGFiZWxzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogR3JhbnQgcHJpbmNpcGFsIHVzZWQgdG8gYWRkIHBlcm1pc3Npb25zIHRvIHRoZSBydW5uZXIgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGdyYW50UHJpbmNpcGFsOiBpYW0uSVByaW5jaXBhbDtcblxuICAvKipcbiAgICogRG9ja2VyIGltYWdlIGxvYWRlZCB3aXRoIEdpdEh1YiBBY3Rpb25zIFJ1bm5lciBhbmQgaXRzIHByZXJlcXVpc2l0ZXMuIFRoZSBpbWFnZSBpcyBidWlsdCBieSBhbiBpbWFnZSBidWlsZGVyIGFuZCBpcyBzcGVjaWZpYyB0byBMYW1iZGEuXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIFRoaXMgZmllbGQgaXMgaW50ZXJuYWwgYW5kIHNob3VsZCBub3QgYmUgYWNjZXNzZWQgZGlyZWN0bHkuXG4gICAqL1xuICByZWFkb25seSBpbWFnZTogUnVubmVySW1hZ2U7XG5cbiAgLyoqXG4gICAqIExvZyBncm91cCB3aGVyZSBwcm92aWRlZCBydW5uZXJzIHdpbGwgc2F2ZSB0aGVpciBsb2dzLlxuICAgKlxuICAgKiBOb3RlIHRoYXQgdGhpcyBpcyBub3QgdGhlIGpvYiBsb2csIGJ1dCB0aGUgcnVubmVyIGl0c2VsZi4gSXQgd2lsbCBub3QgY29udGFpbiBvdXRwdXQgZnJvbSB0aGUgR2l0SHViIEFjdGlvbiBidXQgb25seSBtZXRhZGF0YSBvbiBpdHMgZXhlY3V0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIHJlYWRvbmx5IHJldHJ5YWJsZUVycm9ycyA9IFtcbiAgICAnTGFtYmRhLkxhbWJkYUV4Y2VwdGlvbicsXG4gICAgJ0xhbWJkYS5FYzJUaHJvdHRsZWRFeGNlcHRpb24nLFxuICAgICdMYW1iZGEuRWMyVW5leHBlY3RlZEV4Y2VwdGlvbicsXG4gICAgJ0xhbWJkYS5FbmlMaW1pdFJlYWNoZWRFeGNlcHRpb24nLFxuICAgICdMYW1iZGEuVG9vTWFueVJlcXVlc3RzRXhjZXB0aW9uJyxcbiAgXTtcblxuICBwcml2YXRlIHJlYWRvbmx5IGdyb3VwPzogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGRlZmF1bHRMYWJlbHM6IGJvb2xlYW47XG4gIHByaXZhdGUgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IExhbWJkYVJ1bm5lclByb3ZpZGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIHRoaXMubGFiZWxzID0gdGhpcy5sYWJlbHNGcm9tUHJvcGVydGllcygnbGFtYmRhJywgcHJvcHM/LmxhYmVsLCBwcm9wcz8ubGFiZWxzKTtcbiAgICB0aGlzLmdyb3VwID0gcHJvcHM/Lmdyb3VwO1xuICAgIHRoaXMuZGVmYXVsdExhYmVscyA9IHByb3BzPy5kZWZhdWx0TGFiZWxzID8/IHRydWU7XG4gICAgdGhpcy52cGMgPSBwcm9wcz8udnBjO1xuICAgIHRoaXMuc2VjdXJpdHlHcm91cHMgPSBwcm9wcz8uc2VjdXJpdHlHcm91cCA/IFtwcm9wcy5zZWN1cml0eUdyb3VwXSA6IHByb3BzPy5zZWN1cml0eUdyb3VwcztcblxuICAgIGNvbnN0IGltYWdlQnVpbGRlciA9IHByb3BzPy5pbWFnZUJ1aWxkZXIgPz8gTGFtYmRhUnVubmVyUHJvdmlkZXIuaW1hZ2VCdWlsZGVyKHRoaXMsICdJbWFnZSBCdWlsZGVyJyk7XG4gICAgY29uc3QgaW1hZ2UgPSB0aGlzLmltYWdlID0gaW1hZ2VCdWlsZGVyLmJpbmREb2NrZXJJbWFnZSgpO1xuXG4gICAgbGV0IGFyY2hpdGVjdHVyZTogbGFtYmRhLkFyY2hpdGVjdHVyZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAoaW1hZ2Uub3MuaXNJbihPcy5fQUxMX0xJTlVYX1ZFUlNJT05TKSkge1xuICAgICAgaWYgKGltYWdlLmFyY2hpdGVjdHVyZS5pcyhBcmNoaXRlY3R1cmUuWDg2XzY0KSkge1xuICAgICAgICBhcmNoaXRlY3R1cmUgPSBsYW1iZGEuQXJjaGl0ZWN0dXJlLlg4Nl82NDtcbiAgICAgIH1cbiAgICAgIGlmIChpbWFnZS5hcmNoaXRlY3R1cmUuaXMoQXJjaGl0ZWN0dXJlLkFSTTY0KSkge1xuICAgICAgICBhcmNoaXRlY3R1cmUgPSBsYW1iZGEuQXJjaGl0ZWN0dXJlLkFSTV82NDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWFyY2hpdGVjdHVyZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gZmluZCBzdXBwb3J0ZWQgTGFtYmRhIGFyY2hpdGVjdHVyZSBmb3IgJHtpbWFnZS5vcy5uYW1lfS8ke2ltYWdlLmFyY2hpdGVjdHVyZS5uYW1lfWApO1xuICAgIH1cblxuICAgIGlmICghaW1hZ2UuX2RlcGVuZGFibGUpIHtcbiAgICAgIC8vIEFXUyBJbWFnZSBCdWlsZGVyIGNhbid0IGdldCB1cyBkZXBlbmRhYmxlIGltYWdlcyBhbmQgdGhlcmUgaXMgbm8gcG9pbnQgaW4gdXNpbmcgaXQgYW55d2F5LiBDb2RlQnVpbGQgaXMgc28gbXVjaCBmYXN0ZXIuXG4gICAgICAvLyBUaGlzIG1heSBjaGFuZ2UgaWYgTGFtYmRhIHN0YXJ0cyBzdXBwb3J0aW5nIFdpbmRvd3MgaW1hZ2VzLiBUaGVuIHdlIHdvdWxkIG5lZWQgQVdTIEltYWdlIEJ1aWxkZXIuXG4gICAgICBjZGsuQW5ub3RhdGlvbnMub2YodGhpcykuYWRkRXJyb3IoJ0xhbWJkYSBwcm92aWRlciBjYW4gb25seSB3b3JrIHdpdGggaW1hZ2VzIGJ1aWx0IGJ5IENvZGVCdWlsZCBhbmQgbm90IEFXUyBJbWFnZSBCdWlsZGVyLiBgd2FpdE9uRGVwbG95OiBmYWxzZWAgaXMgYWxzbyBub3Qgc3VwcG9ydGVkLicpO1xuICAgIH1cblxuICAgIC8vIGdldCBpbWFnZSBkaWdlc3QgYW5kIG1ha2Ugc3VyZSB0byBnZXQgaXQgZXZlcnkgdGltZSB0aGUgbGFtYmRhIGZ1bmN0aW9uIG1pZ2h0IGJlIHVwZGF0ZWRcbiAgICAvLyBwYXNzIGFsbCB2YXJpYWJsZXMgdGhhdCBtYXkgY2hhbmdlIGFuZCBjYXVzZSBhIGZ1bmN0aW9uIHVwZGF0ZVxuICAgIC8vIGlmIHdlIGRvbid0IGdldCB0aGUgbGF0ZXN0IGRpZ2VzdCwgdGhlIHVwZGF0ZSBtYXkgZmFpbCBhcyBhIG5ldyBpbWFnZSB3YXMgYWxyZWFkeSBidWlsdCBvdXRzaWRlIHRoZSBzdGFjayBvbiBhIHNjaGVkdWxlXG4gICAgLy8gd2UgYXV0b21hdGljYWxseSBkZWxldGUgb2xkIGltYWdlcywgc28gd2UgbXVzdCBhbHdheXMgZ2V0IHRoZSBsYXRlc3QgZGlnZXN0XG4gICAgY29uc3QgaW1hZ2VEaWdlc3QgPSB0aGlzLmltYWdlRGlnZXN0KGltYWdlLCB7XG4gICAgICB2ZXJzaW9uOiAxLCAvLyBidW1wIHRoaXMgZm9yIGFueSBub24tdXNlciBjaGFuZ2VzIGxpa2UgZGVzY3JpcHRpb24gb3IgZGVmYXVsdHNcbiAgICAgIGxhYmVsczogdGhpcy5sYWJlbHMsXG4gICAgICBhcmNoaXRlY3R1cmU6IGFyY2hpdGVjdHVyZS5uYW1lLFxuICAgICAgdnBjOiB0aGlzLnZwYz8udnBjSWQsXG4gICAgICBzZWN1cml0eUdyb3VwczogdGhpcy5zZWN1cml0eUdyb3Vwcz8ubWFwKHNnID0+IHNnLnNlY3VyaXR5R3JvdXBJZCksXG4gICAgICB2cGNTdWJuZXRzOiBwcm9wcz8uc3VibmV0U2VsZWN0aW9uPy5zdWJuZXRzPy5tYXAocyA9PiBzLnN1Ym5ldElkKSxcbiAgICAgIHRpbWVvdXQ6IHByb3BzPy50aW1lb3V0Py50b1NlY29uZHMoKSxcbiAgICAgIG1lbW9yeVNpemU6IHByb3BzPy5tZW1vcnlTaXplLFxuICAgICAgZXBoZW1lcmFsU3RvcmFnZVNpemU6IHByb3BzPy5lcGhlbWVyYWxTdG9yYWdlU2l6ZT8udG9LaWJpYnl0ZXMoKSxcbiAgICAgIGxvZ1JldGVudGlvbjogcHJvcHM/LmxvZ1JldGVudGlvbj8udG9GaXhlZCgpLFxuICAgICAgLy8gdXBkYXRlIG9uIGltYWdlIGJ1aWxkIHRvbyB0byBhdm9pZCBjb25mbGljdCBvZiB0aGUgc2NoZWR1bGVkIHVwZGF0ZXIgYW5kIGFueSBvdGhlciBDREsgdXBkYXRlcyBsaWtlIFZQQ1xuICAgICAgLy8gdGhpcyBhbHNvIGhlbHBzIHdpdGggcm9sbGJhY2tzIGFzIGl0IHdpbGwgYWx3YXlzIGdldCB0aGUgcmlnaHQgZGlnZXN0IGFuZCBwcmV2ZW50IHJvbGxiYWNrcyB1c2luZyBkZWxldGVkIGltYWdlcyBmcm9tIGZhaWxpbmdcbiAgICAgIGRlcGVuZGFibGU6IGltYWdlLl9kZXBlbmRhYmxlLFxuICAgIH0pO1xuXG4gICAgdGhpcy5sb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdMb2cnLCB7XG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgcmV0ZW50aW9uOiBwcm9wcz8ubG9nUmV0ZW50aW9uID8/IFJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIH0pO1xuXG4gICAgdGhpcy5mdW5jdGlvbiA9IG5ldyBsYW1iZGEuRG9ja2VySW1hZ2VGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICAnRnVuY3Rpb24nLFxuICAgICAge1xuICAgICAgICBkZXNjcmlwdGlvbjogYEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBmb3IgbGFiZWxzICR7dGhpcy5sYWJlbHN9YCxcbiAgICAgICAgLy8gQ0RLIHJlcXVpcmVzIFwic2hhMjU2OlwiIGxpdGVyYWwgcHJlZml4IC0tIGh0dHBzOi8vZ2l0aHViLmNvbS9hd3MvYXdzLWNkay9ibG9iL2JhOTFjYTQ1YWQ3NTlhYjVkYjZkYTE3YTYyMzMzZTJiYzExZTEwNzUvcGFja2FnZXMvJTQwYXdzLWNkay9hd3MtZWNyL2xpYi9yZXBvc2l0b3J5LnRzI0wxODRcbiAgICAgICAgY29kZTogbGFtYmRhLkRvY2tlckltYWdlQ29kZS5mcm9tRWNyKGltYWdlLmltYWdlUmVwb3NpdG9yeSwgeyB0YWdPckRpZ2VzdDogYHNoYTI1Njoke2ltYWdlRGlnZXN0fWAgfSksXG4gICAgICAgIGFyY2hpdGVjdHVyZSxcbiAgICAgICAgdnBjOiB0aGlzLnZwYyxcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHMsXG4gICAgICAgIHZwY1N1Ym5ldHM6IHByb3BzPy5zdWJuZXRTZWxlY3Rpb24sXG4gICAgICAgIHRpbWVvdXQ6IHByb3BzPy50aW1lb3V0IHx8IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSxcbiAgICAgICAgbWVtb3J5U2l6ZTogcHJvcHM/Lm1lbW9yeVNpemUgfHwgMjA0OCxcbiAgICAgICAgZXBoZW1lcmFsU3RvcmFnZVNpemU6IHByb3BzPy5lcGhlbWVyYWxTdG9yYWdlU2l6ZSB8fCBjZGsuU2l6ZS5naWJpYnl0ZXMoMTApLFxuICAgICAgICBsb2dHcm91cDogdGhpcy5sb2dHcm91cCxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHRoaXMuZ3JhbnRQcmluY2lwYWwgPSB0aGlzLmZ1bmN0aW9uLmdyYW50UHJpbmNpcGFsO1xuXG4gICAgdGhpcy5hZGRJbWFnZVVwZGF0ZXIoaW1hZ2UpO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBuZXR3b3JrIGNvbm5lY3Rpb25zIGFzc29jaWF0ZWQgd2l0aCB0aGlzIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIGdldCBjb25uZWN0aW9ucygpOiBlYzIuQ29ubmVjdGlvbnMge1xuICAgIHJldHVybiB0aGlzLmZ1bmN0aW9uLmNvbm5lY3Rpb25zO1xuICB9XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlIHN0ZXAgZnVuY3Rpb24gdGFzayhzKSB0byBzdGFydCBhIG5ldyBydW5uZXIuXG4gICAqXG4gICAqIENhbGxlZCBieSBHaXRodWJSdW5uZXJzIGFuZCBzaG91bGRuJ3QgYmUgY2FsbGVkIG1hbnVhbGx5LlxuICAgKlxuICAgKiBAcGFyYW0gcGFyYW1ldGVycyB3b3JrZmxvdyBqb2IgZGV0YWlsc1xuICAgKi9cbiAgZ2V0U3RlcEZ1bmN0aW9uVGFzayhwYXJhbWV0ZXJzOiBSdW5uZXJSdW50aW1lUGFyYW1ldGVycyk6IHN0ZXBmdW5jdGlvbnMuSUNoYWluYWJsZSB7XG4gICAgcmV0dXJuIG5ldyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkxhbWJkYUludm9rZShcbiAgICAgIHRoaXMsXG4gICAgICAnU3RhdGUnLFxuICAgICAge1xuICAgICAgICBzdGF0ZU5hbWU6IGdlbmVyYXRlU3RhdGVOYW1lKHRoaXMpLFxuICAgICAgICBsYW1iZGFGdW5jdGlvbjogdGhpcy5mdW5jdGlvbixcbiAgICAgICAgcGF5bG9hZDogc3RlcGZ1bmN0aW9ucy5UYXNrSW5wdXQuZnJvbU9iamVjdCh7XG4gICAgICAgICAgdG9rZW46IHBhcmFtZXRlcnMucnVubmVyVG9rZW5QYXRoLFxuICAgICAgICAgIHJ1bm5lck5hbWU6IHBhcmFtZXRlcnMucnVubmVyTmFtZVBhdGgsXG4gICAgICAgICAgbGFiZWw6IHBhcmFtZXRlcnMubGFiZWxzUGF0aCxcbiAgICAgICAgICBnaXRodWJEb21haW46IHBhcmFtZXRlcnMuZ2l0aHViRG9tYWluUGF0aCxcbiAgICAgICAgICBvd25lcjogcGFyYW1ldGVycy5vd25lclBhdGgsXG4gICAgICAgICAgcmVwbzogcGFyYW1ldGVycy5yZXBvUGF0aCxcbiAgICAgICAgICByZWdpc3RyYXRpb25Vcmw6IHBhcmFtZXRlcnMucmVnaXN0cmF0aW9uVXJsLFxuICAgICAgICAgIGdyb3VwOiB0aGlzLmdyb3VwID8gYC0tcnVubmVyZ3JvdXAgJHt0aGlzLmdyb3VwfWAgOiAnJyxcbiAgICAgICAgICBkZWZhdWx0TGFiZWxzOiB0aGlzLmRlZmF1bHRMYWJlbHMgPyAnJyA6ICctLW5vLWRlZmF1bHQtbGFiZWxzJyxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFkZEltYWdlVXBkYXRlcihpbWFnZTogUnVubmVySW1hZ2UpIHtcbiAgICAvLyBMYW1iZGEgbmVlZHMgdG8gYmUgcG9pbnRpbmcgdG8gYSBzcGVjaWZpYyBpbWFnZSBkaWdlc3QgYW5kIG5vdCBqdXN0IGEgdGFnLlxuICAgIC8vIFdoZW5ldmVyIHdlIHVwZGF0ZSB0aGUgdGFnIHRvIGEgbmV3IGRpZ2VzdCwgd2UgbmVlZCB0byB1cGRhdGUgdGhlIGxhbWJkYS5cblxuICAgIGNvbnN0IHVwZGF0ZXIgPSBzaW5nbGV0b25MYW1iZGEoVXBkYXRlTGFtYmRhRnVuY3Rpb24sIHRoaXMsICd1cGRhdGUtbGFtYmRhJywge1xuICAgICAgZGVzY3JpcHRpb246ICdGdW5jdGlvbiB0aGF0IHVwZGF0ZXMgYSBHaXRIdWIgQWN0aW9ucyBydW5uZXIgZnVuY3Rpb24gd2l0aCB0aGUgbGF0ZXN0IGltYWdlIGRpZ2VzdCBhZnRlciB0aGUgaW1hZ2UgaGFzIGJlZW4gcmVidWlsdCcsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXG4gICAgICBsb2dHcm91cDogc2luZ2xldG9uTG9nR3JvdXAodGhpcywgU2luZ2xldG9uTG9nVHlwZS5SVU5ORVJfSU1BR0VfQlVJTEQpLFxuICAgICAgbG9nZ2luZ0Zvcm1hdDogbGFtYmRhLkxvZ2dpbmdGb3JtYXQuSlNPTixcbiAgICB9KTtcblxuICAgIHVwZGF0ZXIuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnbGFtYmRhOlVwZGF0ZUZ1bmN0aW9uQ29kZSddLFxuICAgICAgcmVzb3VyY2VzOiBbdGhpcy5mdW5jdGlvbi5mdW5jdGlvbkFybl0sXG4gICAgfSkpO1xuXG4gICAgbGV0IGxhbWJkYVRhcmdldCA9IG5ldyBldmVudHNfdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbih1cGRhdGVyLCB7XG4gICAgICBldmVudDogZXZlbnRzLlJ1bGVUYXJnZXRJbnB1dC5mcm9tT2JqZWN0KHtcbiAgICAgICAgbGFtYmRhTmFtZTogdGhpcy5mdW5jdGlvbi5mdW5jdGlvbk5hbWUsXG4gICAgICAgIHJlcG9zaXRvcnlVcmk6IGltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgICByZXBvc2l0b3J5VGFnOiBpbWFnZS5pbWFnZVRhZyxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcnVsZSA9IGltYWdlLmltYWdlUmVwb3NpdG9yeS5vbkV2ZW50KCdQdXNoIHJ1bGUnLCB7XG4gICAgICBjcm9zc1N0YWNrU2NvcGU6IHRoaXMsIC8vIGFsbG93IHByb3ZpZGVyIGFuZCBpbWFnZSBidWlsZGVyIHRvIGJlIGluIGRpZmZlcmVudCBzdGFja3NcbiAgICAgIGRlc2NyaXB0aW9uOiAnVXBkYXRlIEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBMYW1iZGEgb24gRUNSIGltYWdlIHB1c2gnLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIGRldGFpbFR5cGU6IFsnRUNSIEltYWdlIEFjdGlvbiddLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICAnYWN0aW9uLXR5cGUnOiBbJ1BVU0gnXSxcbiAgICAgICAgICAncmVwb3NpdG9yeS1uYW1lJzogW2ltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5TmFtZV0sXG4gICAgICAgICAgJ2ltYWdlLXRhZyc6IFtpbWFnZS5pbWFnZVRhZ10sXG4gICAgICAgICAgJ3Jlc3VsdCc6IFsnU1VDQ0VTUyddLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHRhcmdldDogbGFtYmRhVGFyZ2V0LFxuICAgIH0pO1xuXG4gICAgLy8gdGhlIGV2ZW50IG5ldmVyIHRyaWdnZXJzIHdpdGhvdXQgdGhpcyAtIG5vdCBzdXJlIHdoeVxuICAgIChydWxlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGV2ZW50cy5DZm5SdWxlKS5hZGREZWxldGlvbk92ZXJyaWRlKCdQcm9wZXJ0aWVzLkV2ZW50UGF0dGVybi5yZXNvdXJjZXMnKTtcbiAgfVxuXG4gIGdyYW50U3RhdGVNYWNoaW5lKF86IGlhbS5JR3JhbnRhYmxlKSB7XG4gIH1cblxuICBzdGF0dXMoc3RhdHVzRnVuY3Rpb25Sb2xlOiBpYW0uSUdyYW50YWJsZSk6IElSdW5uZXJQcm92aWRlclN0YXR1cyB7XG4gICAgdGhpcy5pbWFnZS5pbWFnZVJlcG9zaXRvcnkuZ3JhbnQoc3RhdHVzRnVuY3Rpb25Sb2xlLCAnZWNyOkRlc2NyaWJlSW1hZ2VzJyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgdHlwZTogdGhpcy5jb25zdHJ1Y3Rvci5uYW1lLFxuICAgICAgbGFiZWxzOiB0aGlzLmxhYmVscyxcbiAgICAgIGNvbnN0cnVjdFBhdGg6IHRoaXMubm9kZS5wYXRoLFxuICAgICAgdnBjQXJuOiB0aGlzLnZwYz8udnBjQXJuLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHM/Lm1hcChzZyA9PiBzZy5zZWN1cml0eUdyb3VwSWQpLFxuICAgICAgcm9sZUFybjogdGhpcy5mdW5jdGlvbi5yb2xlPy5yb2xlQXJuLFxuICAgICAgbG9nR3JvdXA6IHRoaXMuZnVuY3Rpb24ubG9nR3JvdXAubG9nR3JvdXBOYW1lLFxuICAgICAgaW1hZ2U6IHtcbiAgICAgICAgaW1hZ2VSZXBvc2l0b3J5OiB0aGlzLmltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgICBpbWFnZVRhZzogdGhpcy5pbWFnZS5pbWFnZVRhZyxcbiAgICAgICAgaW1hZ2VCdWlsZGVyTG9nR3JvdXA6IHRoaXMuaW1hZ2UubG9nR3JvdXA/LmxvZ0dyb3VwTmFtZSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgaW1hZ2VEaWdlc3QoaW1hZ2U6IFJ1bm5lckltYWdlLCB2YXJpYWJsZVNldHRpbmdzOiBhbnkpOiBzdHJpbmcge1xuICAgIC8vIGRlc2NyaWJlIEVDUiBpbWFnZSB0byBnZXQgaXRzIGRpZ2VzdFxuICAgIC8vIHRoZSBwaHlzaWNhbCBpZCBpcyByYW5kb20gc28gdGhlIHJlc291cmNlIGFsd2F5cyBydW5zIGFuZCBhbHdheXMgZ2V0cyB0aGUgbGF0ZXN0IGRpZ2VzdCwgZXZlbiBpZiBhIHNjaGVkdWxlZCBidWlsZCByZXBsYWNlZCB0aGUgc3RhY2sgaW1hZ2VcbiAgICBjb25zdCByZWFkZXIgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0ltYWdlIERpZ2VzdCBSZWFkZXInLCB7XG4gICAgICBvbkNyZWF0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnRUNSJyxcbiAgICAgICAgYWN0aW9uOiAnZGVzY3JpYmVJbWFnZXMnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgcmVwb3NpdG9yeU5hbWU6IGltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5TmFtZSxcbiAgICAgICAgICBpbWFnZUlkczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBpbWFnZVRhZzogaW1hZ2UuaW1hZ2VUYWcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdJbWFnZURpZ2VzdCcpLFxuICAgICAgfSxcbiAgICAgIG9uVXBkYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdFQ1InLFxuICAgICAgICBhY3Rpb246ICdkZXNjcmliZUltYWdlcycsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICByZXBvc2l0b3J5TmFtZTogaW1hZ2UuaW1hZ2VSZXBvc2l0b3J5LnJlcG9zaXRvcnlOYW1lLFxuICAgICAgICAgIGltYWdlSWRzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGltYWdlVGFnOiBpbWFnZS5pbWFnZVRhZyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ0ltYWdlRGlnZXN0JyksXG4gICAgICB9LFxuICAgICAgb25EZWxldGU6IHtcbiAgICAgICAgLy8gdGhpcyB3aWxsIE5PVCBiZSBjYWxsZWQgdGhhbmtzIHRvIFJlbW92YWxQb2xpY3kuUkVUQUlOIGJlbG93XG4gICAgICAgIC8vIHdlIG9ubHkgdXNlIHRoaXMgdG8gZm9yY2UgdGhlIGN1c3RvbSByZXNvdXJjZSB0byBiZSBjYWxsZWQgYWdhaW4gYW5kIGdldCBhIG5ldyBkaWdlc3RcbiAgICAgICAgc2VydmljZTogJ2Zha2UnLFxuICAgICAgICBhY3Rpb246ICdmYWtlJyxcbiAgICAgICAgcGFyYW1ldGVyczogdmFyaWFibGVTZXR0aW5ncyxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TZGtDYWxscyh7XG4gICAgICAgIHJlc291cmNlczogW2ltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuXSxcbiAgICAgIH0pLFxuICAgICAgcmVzb3VyY2VUeXBlOiAnQ3VzdG9tOjpFY3JJbWFnZURpZ2VzdCcsXG4gICAgICBpbnN0YWxsTGF0ZXN0QXdzU2RrOiBmYWxzZSwgLy8gbm8gbmVlZCBhbmQgaXQgdGFrZXMgNjAgc2Vjb25kc1xuICAgICAgbG9nR3JvdXA6IHNpbmdsZXRvbkxvZ0dyb3VwKHRoaXMsIFNpbmdsZXRvbkxvZ1R5cGUuUlVOTkVSX0lNQUdFX0JVSUxEKSxcbiAgICB9KTtcblxuICAgIC8vIG1hcmsgdGhpcyByZXNvdXJjZSBhcyByZXRhaW5hYmxlLCBhcyB0aGVyZSBpcyBub3RoaW5nIHRvIGRvIG9uIGRlbGV0ZVxuICAgIGNvbnN0IHJlcyA9IHJlYWRlci5ub2RlLnRyeUZpbmRDaGlsZCgnUmVzb3VyY2UnKSBhcyBjZGsuQ3VzdG9tUmVzb3VyY2UgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHJlcykge1xuICAgICAgLy8gZG9uJ3QgYWN0dWFsbHkgY2FsbCB0aGUgZmFrZSBvbkRlbGV0ZSBhYm92ZVxuICAgICAgcmVzLmFwcGx5UmVtb3ZhbFBvbGljeShjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU4pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Jlc291cmNlIG5vdCBmb3VuZCBpbiBBd3NDdXN0b21SZXNvdXJjZS4gUmVwb3J0IHRoaXMgYnVnIGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9DbG91ZFNub3JrZWwvY2RrLWdpdGh1Yi1ydW5uZXJzL2lzc3Vlcy4nKTtcbiAgICB9XG5cbiAgICAvLyByZXR1cm4gb25seSB0aGUgZGlnZXN0IGJlY2F1c2UgQ0RLIGV4cGVjdHMgJ3NoYTI1NjonIGxpdGVyYWwgYWJvdmVcbiAgICByZXR1cm4gY2RrLkZuLnNwbGl0KCc6JywgcmVhZGVyLmdldFJlc3BvbnNlRmllbGQoJ2ltYWdlRGV0YWlscy4wLmltYWdlRGlnZXN0JyksIDIpWzFdO1xuICB9XG59XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgdXNlIHtAbGluayBMYW1iZGFSdW5uZXJQcm92aWRlcn1cbiAqL1xuZXhwb3J0IGNsYXNzIExhbWJkYVJ1bm5lciBleHRlbmRzIExhbWJkYVJ1bm5lclByb3ZpZGVyIHtcbn1cbiJdfQ==