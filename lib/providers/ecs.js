"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EcsRunnerProvider = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const cdk = require("aws-cdk-lib");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
const aws_ecs_1 = require("aws-cdk-lib/aws-ecs");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const aws_stepfunctions_1 = require("aws-cdk-lib/aws-stepfunctions");
const common_1 = require("./common");
const fargate_1 = require("./fargate");
const image_builders_1 = require("../image-builders");
const utils_1 = require("../utils");
/**
 * Custom ECS EC2 launch target that allows specifying capacity provider strategy and propagating tags.
 */
class CustomEcsEc2LaunchTarget extends aws_cdk_lib_1.aws_stepfunctions_tasks.EcsEc2LaunchTarget {
    constructor(options) {
        super(options);
        this.capacityProvider = options.capacityProvider;
    }
    /**
     * Called when the ECS launch type configured on RunTask
     */
    bind(_task, _launchTargetOptions) {
        const base = super.bind(_task, _launchTargetOptions);
        return {
            ...base,
            parameters: {
                ...(base.parameters ?? {}),
                PropagateTags: aws_cdk_lib_1.aws_ecs.PropagatedTagSource.TASK_DEFINITION,
                CapacityProviderStrategy: [
                    {
                        CapacityProvider: this.capacityProvider,
                    },
                ],
                LaunchType: undefined, // You may choose a capacity provider or a launch type but not both.
            },
        };
    }
}
/**
 * GitHub Actions runner provider using ECS on EC2 to execute jobs.
 *
 * ECS can be useful when you want more control of the infrastructure running the GitHub Actions Docker containers. You can control the autoscaling
 * group to scale down to zero during the night and scale up during work hours. This way you can still save money, but have to wait less for
 * infrastructure to spin up.
 *
 * This construct is not meant to be used by itself. It should be passed in the providers property for GitHubRunners.
 */
class EcsRunnerProvider extends common_1.BaseProvider {
    /**
     * Create new image builder that builds ECS specific runner images.
     *
     * You can customize the OS, architecture, VPC, subnet, security groups, etc. by passing in props.
     *
     * You can add components to the image builder by calling `imageBuilder.addComponent()`.
     *
     * The default OS is Ubuntu running on x64 architecture.
     *
     * Included components:
     *  * `RunnerImageComponent.requiredPackages()`
     *  * `RunnerImageComponent.runnerUser()`
     *  * `RunnerImageComponent.git()`
     *  * `RunnerImageComponent.githubCli()`
     *  * `RunnerImageComponent.awsCli()`
     *  * `RunnerImageComponent.docker()`
     *  * `RunnerImageComponent.githubRunner()`
     */
    static imageBuilder(scope, id, props) {
        return image_builders_1.RunnerImageBuilder.new(scope, id, {
            os: common_1.Os.LINUX_UBUNTU,
            architecture: common_1.Architecture.X86_64,
            components: [
                image_builders_1.RunnerImageComponent.requiredPackages(),
                image_builders_1.RunnerImageComponent.runnerUser(),
                image_builders_1.RunnerImageComponent.git(),
                image_builders_1.RunnerImageComponent.githubCli(),
                image_builders_1.RunnerImageComponent.awsCli(),
                image_builders_1.RunnerImageComponent.docker(),
                image_builders_1.RunnerImageComponent.githubRunner(props?.runnerVersion ?? common_1.RunnerVersion.latest()),
            ],
            ...props,
        });
    }
    constructor(scope, id, props) {
        super(scope, id, props);
        this.retryableErrors = [
            'Ecs.EcsException',
            'ECS.AmazonECSException',
            'Ecs.LimitExceededException',
            'Ecs.UpdateInProgressException',
        ];
        this.labels = props?.labels ?? ['ecs'];
        this.group = props?.group;
        this.defaultLabels = props?.defaultLabels ?? true;
        this.vpc = props?.vpc ?? aws_cdk_lib_1.aws_ec2.Vpc.fromLookup(this, 'default vpc', { isDefault: true });
        this.subnetSelection = props?.subnetSelection;
        this.securityGroups = props?.securityGroups ?? [new aws_cdk_lib_1.aws_ec2.SecurityGroup(this, 'security group', { vpc: this.vpc })];
        this.connections = new aws_cdk_lib_1.aws_ec2.Connections({ securityGroups: this.securityGroups });
        this.assignPublicIp = props?.assignPublicIp ?? true;
        this.placementStrategies = props?.placementStrategies;
        this.placementConstraints = props?.placementConstraints;
        this.gpuCount = props?.gpu ?? 0;
        this.cluster = props?.cluster ? props.cluster : new aws_cdk_lib_1.aws_ecs.Cluster(this, 'cluster', {
            vpc: this.vpc,
            enableFargateCapacityProviders: false,
        });
        if (props?.storageOptions && !props?.storageSize) {
            throw new Error('storageSize is required when storageOptions are specified');
        }
        const defaultImageBuilderArchitecture = !props?.capacityProvider && props?.instanceType?.architecture === aws_cdk_lib_1.aws_ec2.InstanceArchitecture.ARM_64
            ? common_1.Architecture.ARM64
            : common_1.Architecture.X86_64;
        const imageBuilder = props?.imageBuilder ?? EcsRunnerProvider.imageBuilder(this, 'Image Builder', {
            architecture: defaultImageBuilderArchitecture,
        });
        const image = this.image = imageBuilder.bindDockerImage();
        if (props?.capacityProvider) {
            if (props?.minInstances || props?.maxInstances || props?.instanceType || props?.storageSize || props?.spot || props?.spotMaxPrice) {
                cdk.Annotations.of(this).addWarning('When using a custom capacity provider, minInstances, maxInstances, instanceType, storageSize, spot, and spotMaxPrice will be ignored.');
            }
            this.capacityProvider = props.capacityProvider;
        }
        else {
            const spot = props?.spot ?? props?.spotMaxPrice !== undefined;
            const launchTemplate = new aws_cdk_lib_1.aws_ec2.LaunchTemplate(this, 'Launch Template', {
                machineImage: this.defaultClusterInstanceAmi(),
                instanceType: props?.instanceType ?? this.defaultClusterInstanceType(),
                blockDevices: props?.storageSize ? [
                    {
                        deviceName: (0, common_1.amiRootDevice)(this, this.defaultClusterInstanceAmi().getImage(this).imageId).ref,
                        volume: {
                            ebsDevice: {
                                deleteOnTermination: true,
                                volumeSize: props.storageSize.toGibibytes(),
                                volumeType: props.storageOptions?.volumeType,
                                iops: props.storageOptions?.iops,
                                throughput: props.storageOptions?.throughput,
                            },
                        },
                    },
                ] : undefined,
                spotOptions: spot ? {
                    requestType: aws_cdk_lib_1.aws_ec2.SpotRequestType.ONE_TIME,
                    maxPrice: props?.spotMaxPrice ? parseFloat(props?.spotMaxPrice) : undefined,
                } : undefined,
                requireImdsv2: true,
                securityGroup: this.securityGroups[0],
                role: new aws_cdk_lib_1.aws_iam.Role(this, 'Launch Template Role', {
                    assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
                }),
                userData: aws_cdk_lib_1.aws_ec2.UserData.forOperatingSystem(image.os.is(common_1.Os.WINDOWS) ? aws_cdk_lib_1.aws_ec2.OperatingSystemType.WINDOWS : aws_cdk_lib_1.aws_ec2.OperatingSystemType.LINUX),
            });
            this.securityGroups.slice(1).map(sg => launchTemplate.connections.addSecurityGroup(sg));
            const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'Auto Scaling Group', {
                vpc: this.vpc,
                launchTemplate,
                vpcSubnets: this.subnetSelection,
                minCapacity: props?.minInstances ?? 0,
                maxCapacity: props?.maxInstances ?? 5,
            });
            this.capacityProvider = props?.capacityProvider ?? new aws_cdk_lib_1.aws_ecs.AsgCapacityProvider(this, 'Capacity Provider', {
                autoScalingGroup,
                spotInstanceDraining: false, // waste of money to restart jobs as the restarted job won't have a token
            });
        }
        this.capacityProvider.autoScalingGroup.addUserData(
        // we don't exit on errors because all of these commands are optional
        ...this.loginCommands(), this.pullCommand(), ...this.ecsSettingsCommands());
        this.capacityProvider.autoScalingGroup.role.addToPrincipalPolicy(utils_1.MINIMAL_EC2_SSM_SESSION_MANAGER_POLICY_STATEMENT);
        image.imageRepository.grantPull(this.capacityProvider.autoScalingGroup);
        this.cluster.addAsgCapacityProvider(this.capacityProvider, {
            spotInstanceDraining: false,
            machineImageType: aws_ecs_1.MachineImageType.AMAZON_LINUX_2,
        });
        this.logGroup = new aws_cdk_lib_1.aws_logs.LogGroup(this, 'logs', {
            retention: props?.logRetention ?? aws_logs_1.RetentionDays.ONE_MONTH,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        this.dind = (props?.dockerInDocker ?? true) && !image.os.is(common_1.Os.WINDOWS);
        this.task = new aws_cdk_lib_1.aws_ecs.Ec2TaskDefinition(this, 'task');
        this.container = this.task.addContainer('runner', {
            image: aws_cdk_lib_1.aws_ecs.AssetImage.fromEcrRepository(image.imageRepository, image.imageTag),
            cpu: props?.cpu ?? 1024,
            memoryLimitMiB: props?.memoryLimitMiB ?? (props?.memoryReservationMiB ? undefined : 3500),
            memoryReservationMiB: props?.memoryReservationMiB,
            gpuCount: this.gpuCount > 0 ? this.gpuCount : undefined,
            logging: aws_cdk_lib_1.aws_ecs.AwsLogDriver.awsLogs({
                logGroup: this.logGroup,
                streamPrefix: 'runner',
            }),
            command: (0, fargate_1.ecsRunCommand)(this.image.os, this.dind),
            user: image.os.is(common_1.Os.WINDOWS) ? undefined : 'runner',
            privileged: this.dind,
        });
        this.grantPrincipal = this.task.taskRole;
        // permissions for SSM Session Manager
        this.task.taskRole.addToPrincipalPolicy(utils_1.MINIMAL_ECS_SSM_SESSION_MANAGER_POLICY_STATEMENT);
    }
    defaultClusterInstanceType() {
        if (this.gpuCount > 0) {
            if (!this.image.architecture.is(common_1.Architecture.X86_64)) {
                throw new Error('ECS GPU is only supported for x64 architecture. GPU instances (g4dn, g5, p3, etc.) are x64 only.');
            }
            if (this.gpuCount <= 1) {
                return aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.G4DN, aws_cdk_lib_1.aws_ec2.InstanceSize.XLARGE);
            }
            if (this.gpuCount <= 4) {
                return aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.G4DN, aws_cdk_lib_1.aws_ec2.InstanceSize.XLARGE12);
            }
            if (this.gpuCount <= 8) {
                return aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.P3, aws_cdk_lib_1.aws_ec2.InstanceSize.XLARGE16);
            }
            throw new Error(`Unsupported GPU count: ${this.gpuCount}`);
        }
        if (this.image.architecture.is(common_1.Architecture.X86_64)) {
            return aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.M6I, aws_cdk_lib_1.aws_ec2.InstanceSize.LARGE);
        }
        if (this.image.architecture.is(common_1.Architecture.ARM64)) {
            return aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.M6G, aws_cdk_lib_1.aws_ec2.InstanceSize.LARGE);
        }
        throw new Error(`Unable to find instance type for ECS instances for ${this.image.architecture.name}`);
    }
    defaultClusterInstanceAmi() {
        let baseImage;
        let ssmPath;
        let found = false;
        if (this.image.os.isIn(common_1.Os._ALL_LINUX_VERSIONS)) {
            if (this.gpuCount > 0 && this.image.architecture.is(common_1.Architecture.X86_64)) {
                baseImage = aws_cdk_lib_1.aws_ecs.EcsOptimizedImage.amazonLinux2023(aws_cdk_lib_1.aws_ecs.AmiHardwareType.GPU);
                ssmPath = '/aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended/image_id';
                found = true;
            }
            else if (this.image.architecture.is(common_1.Architecture.X86_64)) {
                baseImage = aws_cdk_lib_1.aws_ecs.EcsOptimizedImage.amazonLinux2023(aws_cdk_lib_1.aws_ecs.AmiHardwareType.STANDARD);
                ssmPath = '/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id';
                found = true;
            }
            else if (this.image.architecture.is(common_1.Architecture.ARM64)) {
                baseImage = aws_cdk_lib_1.aws_ecs.EcsOptimizedImage.amazonLinux2023(aws_cdk_lib_1.aws_ecs.AmiHardwareType.ARM);
                ssmPath = '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id';
                found = true;
            }
        }
        if (this.image.os.is(common_1.Os.WINDOWS)) {
            baseImage = aws_cdk_lib_1.aws_ecs.EcsOptimizedImage.windows(aws_cdk_lib_1.aws_ecs.WindowsOptimizedVersion.SERVER_2019);
            ssmPath = '/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-ECS_Optimized/image_id';
            found = true;
        }
        if (!found) {
            throw new Error(`Unable to find AMI for ECS instances for ${this.image.os.name}/${this.image.architecture.name} (gpuCount=${this.gpuCount})`);
        }
        const image = {
            getImage(scope) {
                const baseImageRes = baseImage.getImage(scope);
                return {
                    imageId: `resolve:ssm:${ssmPath}`,
                    userData: baseImageRes.userData,
                    osType: baseImageRes.osType,
                };
            },
        };
        return image;
    }
    pullCommand() {
        if (this.image.os.is(common_1.Os.WINDOWS)) {
            return `Start-Job -ScriptBlock { docker pull ${this.image.imageRepository.repositoryUri}:${this.image.imageTag} }`;
        }
        return `docker pull ${this.image.imageRepository.repositoryUri}:${this.image.imageTag} &`;
    }
    loginCommands() {
        const thisStack = aws_cdk_lib_1.Stack.of(this);
        if (this.image.os.is(common_1.Os.WINDOWS)) {
            return [`(Get-ECRLoginCommand).Password | docker login --username AWS --password-stdin ${thisStack.account}.dkr.ecr.${thisStack.region}.amazonaws.com`];
        }
        return [
            'yum install -y awscli || dnf install -y awscli',
            `aws ecr get-login-password --region ${thisStack.region} | docker login --username AWS --password-stdin ${thisStack.account}.dkr.ecr.${thisStack.region}.amazonaws.com`,
        ];
    }
    ecsSettingsCommands() {
        // don't let ECS accumulate too many stopped tasks that can end up very big in our case
        // the default is 10m duration with 1h jitter which can end up with 1h10m delay for cleaning up stopped tasks
        if (this.image.os.is(common_1.Os.WINDOWS)) {
            return [
                '[Environment]::SetEnvironmentVariable("ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION", "5s", "Machine")',
                '[Environment]::SetEnvironmentVariable("ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION_JITTER", "5s", "Machine")',
                // https://github.com/aws/aws-cdk/issues/36805
                '[Environment]::SetEnvironmentVariable("ECS_ENABLE_TASK_IAM_ROLE", "true", "Machine")',
            ];
        }
        return [
            'echo ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=5s >> /etc/ecs/ecs.config',
            'echo ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION_JITTER=5s >> /etc/ecs/ecs.config',
        ];
    }
    /**
     * Generate step function task(s) to start a new runner.
     *
     * Called by GithubRunners and shouldn't be called manually.
     *
     * @param parameters workflow job details
     */
    getStepFunctionTask(parameters) {
        return new aws_cdk_lib_1.aws_stepfunctions_tasks.EcsRunTask(this, 'State', {
            stateName: (0, common_1.generateStateName)(this),
            integrationPattern: aws_stepfunctions_1.IntegrationPattern.RUN_JOB, // sync
            taskDefinition: this.task,
            cluster: this.cluster,
            launchTarget: new CustomEcsEc2LaunchTarget({
                capacityProvider: this.capacityProvider.capacityProviderName,
                placementStrategies: this.placementStrategies,
                placementConstraints: this.placementConstraints,
            }),
            enableExecuteCommand: this.image.os.isIn(common_1.Os._ALL_LINUX_VERSIONS),
            assignPublicIp: this.assignPublicIp,
            containerOverrides: [
                {
                    containerDefinition: this.container,
                    environment: [
                        {
                            name: 'RUNNER_TOKEN',
                            value: parameters.runnerTokenPath,
                        },
                        {
                            name: 'RUNNER_NAME',
                            value: parameters.runnerNamePath,
                        },
                        {
                            name: 'RUNNER_LABEL',
                            value: parameters.labelsPath,
                        },
                        {
                            name: 'RUNNER_GROUP1',
                            value: this.group ? '--runnergroup' : '',
                        },
                        {
                            name: 'RUNNER_GROUP2',
                            value: this.group ? this.group : '',
                        },
                        {
                            name: 'DEFAULT_LABELS',
                            value: this.defaultLabels ? '' : '--no-default-labels',
                        },
                        {
                            name: 'GITHUB_DOMAIN',
                            value: parameters.githubDomainPath,
                        },
                        {
                            name: 'OWNER',
                            value: parameters.ownerPath,
                        },
                        {
                            name: 'REPO',
                            value: parameters.repoPath,
                        },
                        {
                            name: 'REGISTRATION_URL',
                            value: parameters.registrationUrl,
                        },
                    ],
                },
            ],
        });
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
            securityGroups: this.securityGroups.map(sg => sg.securityGroupId),
            roleArn: this.task.taskRole.roleArn,
            logGroup: this.logGroup.logGroupName,
            image: {
                imageRepository: this.image.imageRepository.repositoryUri,
                imageTag: this.image.imageTag,
                imageBuilderLogGroup: this.image.logGroup?.logGroupName,
            },
        };
    }
}
exports.EcsRunnerProvider = EcsRunnerProvider;
_a = JSII_RTTI_SYMBOL_1;
EcsRunnerProvider[_a] = { fqn: "@cloudsnorkel/cdk-github-runners.EcsRunnerProvider", version: "0.0.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWNzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Byb3ZpZGVycy9lY3MudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSxtQ0FBbUM7QUFDbkMsNkNBU3FCO0FBQ3JCLDJEQUEyRDtBQUMzRCxpREFBdUQ7QUFDdkQsbURBQXFEO0FBQ3JELHFFQUFtRTtBQUVuRSxxQ0Fha0I7QUFDbEIsdUNBQTBDO0FBQzFDLHNEQUEySDtBQUMzSCxvQ0FBOEg7QUF1TTlIOztHQUVHO0FBQ0gsTUFBTSx3QkFBeUIsU0FBUSxxQ0FBbUIsQ0FBQyxrQkFBa0I7SUFHM0UsWUFBWSxPQUFrQztRQUM1QyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDZixJQUFJLENBQUMsZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLGdCQUFnQixDQUFDO0lBQ25ELENBQUM7SUFFRDs7T0FFRztJQUNJLElBQUksQ0FBQyxLQUFxQyxFQUMvQyxvQkFBaUU7UUFDakUsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztRQUNyRCxPQUFPO1lBQ0wsR0FBRyxJQUFJO1lBQ1AsVUFBVSxFQUFFO2dCQUNWLEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQztnQkFDMUIsYUFBYSxFQUFFLHFCQUFHLENBQUMsbUJBQW1CLENBQUMsZUFBZTtnQkFDdEQsd0JBQXdCLEVBQUU7b0JBQ3hCO3dCQUNFLGdCQUFnQixFQUFFLElBQUksQ0FBQyxnQkFBZ0I7cUJBQ3hDO2lCQUNGO2dCQUNELFVBQVUsRUFBRSxTQUFTLEVBQUUsb0VBQW9FO2FBQzVGO1NBQ0YsQ0FBQztJQUNKLENBQUM7Q0FDRjtBQUVEOzs7Ozs7OztHQVFHO0FBQ0gsTUFBYSxpQkFBa0IsU0FBUSxxQkFBWTtJQUNqRDs7Ozs7Ozs7Ozs7Ozs7Ozs7T0FpQkc7SUFDSSxNQUFNLENBQUMsWUFBWSxDQUFDLEtBQWdCLEVBQUUsRUFB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QkFDTCxlQUFlLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsYUFBYTtnQkFDekQsUUFBUSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUTtnQkFDN0Isb0JBQW9CLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsWUFBWTthQUN4RDtTQUNGLENBQUM7SUFDSixDQUFDOztBQWplSCw4Q0FrZUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHtcbiAgYXdzX2VjMiBhcyBlYzIsXG4gIGF3c19lY3MgYXMgZWNzLFxuICBhd3NfaWFtIGFzIGlhbSxcbiAgYXdzX2xvZ3MgYXMgbG9ncyxcbiAgYXdzX3N0ZXBmdW5jdGlvbnMgYXMgc3RlcGZ1bmN0aW9ucyxcbiAgYXdzX3N0ZXBmdW5jdGlvbnNfdGFza3MgYXMgc3RlcGZ1bmN0aW9uc190YXNrcyxcbiAgUmVtb3ZhbFBvbGljeSxcbiAgU3RhY2ssXG59IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgeyBNYWNoaW5lSW1hZ2VUeXBlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgeyBSZXRlbnRpb25EYXlzIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgSW50ZWdyYXRpb25QYXR0ZXJuIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLXN0ZXBmdW5jdGlvbnMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQge1xuICBhbWlSb290RGV2aWNlLFxuICBBcmNoaXRlY3R1cmUsXG4gIEJhc2VQcm92aWRlcixcbiAgZ2VuZXJhdGVTdGF0ZU5hbWUsXG4gIElSdW5uZXJQcm92aWRlcixcbiAgSVJ1bm5lclByb3ZpZGVyU3RhdHVzLFxuICBPcyxcbiAgUnVubmVySW1hZ2UsXG4gIFJ1bm5lclByb3ZpZGVyUHJvcHMsXG4gIFJ1bm5lclJ1bnRpbWVQYXJhbWV0ZXJzLFxuICBSdW5uZXJWZXJzaW9uLFxuICBTdG9yYWdlT3B0aW9ucyxcbn0gZnJvbSAnLi9jb21tb24nO1xuaW1wb3J0IHsgZWNzUnVuQ29tbWFuZCB9IGZyb20gJy4vZmFyZ2F0ZSc7XG5pbXBvcnQgeyBJUnVubmVySW1hZ2VCdWlsZGVyLCBSdW5uZXJJbWFnZUJ1aWxkZXIsIFJ1bm5lckltYWdlQnVpbGRlclByb3BzLCBSdW5uZXJJbWFnZUNvbXBvbmVudCB9IGZyb20gJy4uL2ltYWdlLWJ1aWxkZXJzJztcbmltcG9ydCB7IE1JTklNQUxfRUMyX1NTTV9TRVNTSU9OX01BTkFHRVJfUE9MSUNZX1NUQVRFTUVOVCwgTUlOSU1BTF9FQ1NfU1NNX1NFU1NJT05fTUFOQUdFUl9QT0xJQ1lfU1RBVEVNRU5UIH0gZnJvbSAnLi4vdXRpbHMnO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEVjc1J1bm5lclByb3ZpZGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEVjc1J1bm5lclByb3ZpZGVyUHJvcHMgZXh0ZW5kcyBSdW5uZXJQcm92aWRlclByb3BzIHtcbiAgLyoqXG4gICAqIFJ1bm5lciBpbWFnZSBidWlsZGVyIHVzZWQgdG8gYnVpbGQgRG9ja2VyIGltYWdlcyBjb250YWluaW5nIEdpdEh1YiBSdW5uZXIgYW5kIGFsbCByZXF1aXJlbWVudHMuXG4gICAqXG4gICAqIFRoZSBpbWFnZSBidWlsZGVyIGRldGVybWluZXMgdGhlIE9TIGFuZCBhcmNoaXRlY3R1cmUgb2YgdGhlIHJ1bm5lci5cbiAgICpcbiAgICogQGRlZmF1bHQgRWNzUnVubmVyUHJvdmlkZXIuaW1hZ2VCdWlsZGVyKClcbiAgICovXG4gIHJlYWRvbmx5IGltYWdlQnVpbGRlcj86IElSdW5uZXJJbWFnZUJ1aWxkZXI7XG5cbiAgLyoqXG4gICAqIEdpdEh1YiBBY3Rpb25zIGxhYmVscyB1c2VkIGZvciB0aGlzIHByb3ZpZGVyLlxuICAgKlxuICAgKiBUaGVzZSBsYWJlbHMgYXJlIHVzZWQgdG8gaWRlbnRpZnkgd2hpY2ggcHJvdmlkZXIgc2hvdWxkIHNwYXduIGEgbmV3IG9uLWRlbWFuZCBydW5uZXIuIEV2ZXJ5IGpvYiBzZW5kcyBhIHdlYmhvb2sgd2l0aCB0aGUgbGFiZWxzIGl0J3MgbG9va2luZyBmb3JcbiAgICogYmFzZWQgb24gcnVucy1vbi4gV2UgbWF0Y2ggdGhlIGxhYmVscyBmcm9tIHRoZSB3ZWJob29rIHdpdGggdGhlIGxhYmVscyBzcGVjaWZpZWQgaGVyZS4gSWYgYWxsIHRoZSBsYWJlbHMgc3BlY2lmaWVkIGhlcmUgYXJlIHByZXNlbnQgaW4gdGhlXG4gICAqIGpvYidzIGxhYmVscywgdGhpcyBwcm92aWRlciB3aWxsIGJlIGNob3NlbiBhbmQgc3Bhd24gYSBuZXcgcnVubmVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCBbJ2VjcyddXG4gICAqL1xuICByZWFkb25seSBsYWJlbHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogR2l0SHViIEFjdGlvbnMgcnVubmVyIGdyb3VwIG5hbWUuXG4gICAqXG4gICAqIElmIHNwZWNpZmllZCwgdGhlIHJ1bm5lciB3aWxsIGJlIHJlZ2lzdGVyZWQgd2l0aCB0aGlzIGdyb3VwIG5hbWUuIFNldHRpbmcgYSBydW5uZXIgZ3JvdXAgY2FuIGhlbHAgbWFuYWdpbmcgYWNjZXNzIHRvIHNlbGYtaG9zdGVkIHJ1bm5lcnMuIEl0XG4gICAqIHJlcXVpcmVzIGEgcGFpZCBHaXRIdWIgYWNjb3VudC5cbiAgICpcbiAgICogVGhlIGdyb3VwIG11c3QgZXhpc3Qgb3IgdGhlIHJ1bm5lciB3aWxsIG5vdCBzdGFydC5cbiAgICpcbiAgICogVXNlcnMgd2lsbCBzdGlsbCBiZSBhYmxlIHRvIHRyaWdnZXIgdGhpcyBydW5uZXIgd2l0aCB0aGUgY29ycmVjdCBsYWJlbHMuIEJ1dCB0aGUgcnVubmVyIHdpbGwgb25seSBiZSBhYmxlIHRvIHJ1biBqb2JzIGZyb20gcmVwb3MgYWxsb3dlZCB0byB1c2UgdGhlIGdyb3VwLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGdyb3VwPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBWUEMgdG8gbGF1bmNoIHRoZSBydW5uZXJzIGluLlxuICAgKlxuICAgKiBAZGVmYXVsdCBkZWZhdWx0IGFjY291bnQgVlBDXG4gICAqL1xuICByZWFkb25seSB2cGM/OiBlYzIuSVZwYztcblxuICAvKipcbiAgICogU3VibmV0cyB0byBydW4gdGhlIHJ1bm5lcnMgaW4uXG4gICAqXG4gICAqIEBkZWZhdWx0IEVDUyBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzdWJuZXRTZWxlY3Rpb24/OiBlYzIuU3VibmV0U2VsZWN0aW9uO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cHMgdG8gYXNzaWduIHRvIHRoZSB0YXNrLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhIG5ldyBzZWN1cml0eSBncm91cFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcblxuICAvKipcbiAgICogRXhpc3RpbmcgRUNTIGNsdXN0ZXIgdG8gdXNlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhIG5ldyBjbHVzdGVyXG4gICAqL1xuICByZWFkb25seSBjbHVzdGVyPzogZWNzLkNsdXN0ZXI7XG5cbiAgLyoqXG4gICAqIEV4aXN0aW5nIGNhcGFjaXR5IHByb3ZpZGVyIHRvIHVzZS5cbiAgICpcbiAgICogTWFrZSBzdXJlIHRoZSBBTUkgdXNlZCBieSB0aGUgY2FwYWNpdHkgcHJvdmlkZXIgaXMgY29tcGF0aWJsZSB3aXRoIEVDUy5cbiAgICpcbiAgICogQGRlZmF1bHQgbmV3IGNhcGFjaXR5IHByb3ZpZGVyXG4gICAqL1xuICByZWFkb25seSBjYXBhY2l0eVByb3ZpZGVyPzogZWNzLkFzZ0NhcGFjaXR5UHJvdmlkZXI7XG5cbiAgLyoqXG4gICAqIEFzc2lnbiBwdWJsaWMgSVAgdG8gdGhlIHJ1bm5lciB0YXNrLlxuICAgKlxuICAgKiBNYWtlIHN1cmUgdGhlIHRhc2sgd2lsbCBoYXZlIGFjY2VzcyB0byBHaXRIdWIuIEEgcHVibGljIElQIG1pZ2h0IGJlIHJlcXVpcmVkIHVubGVzcyB5b3UgaGF2ZSBOQVQgZ2F0ZXdheS5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgYXNzaWduUHVibGljSXA/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBUaGUgbnVtYmVyIG9mIGNwdSB1bml0cyB1c2VkIGJ5IHRoZSB0YXNrLiAxMDI0IHVuaXRzIGlzIDEgdkNQVS4gRnJhY3Rpb25zIG9mIGEgdkNQVSBhcmUgc3VwcG9ydGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCAxMDI0XG4gICAqL1xuICByZWFkb25seSBjcHU/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBhbW91bnQgKGluIE1pQikgb2YgbWVtb3J5IHVzZWQgYnkgdGhlIHRhc2suXG4gICAqXG4gICAqIEBkZWZhdWx0IDM1MDAsIHVubGVzcyBgbWVtb3J5UmVzZXJ2YXRpb25NaUJgIGlzIHVzZWQgYW5kIHRoZW4gaXQncyB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG1lbW9yeUxpbWl0TWlCPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaGUgc29mdCBsaW1pdCAoaW4gTWlCKSBvZiBtZW1vcnkgdG8gcmVzZXJ2ZSBmb3IgdGhlIGNvbnRhaW5lci5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtZW1vcnlSZXNlcnZhdGlvbk1pQj86IG51bWJlcjtcblxuICAvKipcbiAgICogSW5zdGFuY2UgdHlwZSBvZiBFQ1MgY2x1c3RlciBpbnN0YW5jZXMuIE9ubHkgdXNlZCB3aGVuIGNyZWF0aW5nIGEgbmV3IGNsdXN0ZXIuXG4gICAqXG4gICAqIEBkZWZhdWx0IG02aS5sYXJnZSBvciBtNmcubGFyZ2VcbiAgICovXG4gIHJlYWRvbmx5IGluc3RhbmNlVHlwZT86IGVjMi5JbnN0YW5jZVR5cGU7XG5cbiAgLyoqXG4gICAqIFRoZSBtaW5pbXVtIG51bWJlciBvZiBpbnN0YW5jZXMgdG8gcnVuIGluIHRoZSBjbHVzdGVyLiBPbmx5IHVzZWQgd2hlbiBjcmVhdGluZyBhIG5ldyBjbHVzdGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCAwXG4gICAqL1xuICByZWFkb25seSBtaW5JbnN0YW5jZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBtYXhpbXVtIG51bWJlciBvZiBpbnN0YW5jZXMgdG8gcnVuIGluIHRoZSBjbHVzdGVyLiBPbmx5IHVzZWQgd2hlbiBjcmVhdGluZyBhIG5ldyBjbHVzdGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCA1XG4gICAqL1xuICByZWFkb25seSBtYXhJbnN0YW5jZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFNpemUgb2Ygdm9sdW1lIGF2YWlsYWJsZSBmb3IgbGF1bmNoZWQgY2x1c3RlciBpbnN0YW5jZXMuIFRoaXMgbW9kaWZpZXMgdGhlIGJvb3Qgdm9sdW1lIHNpemUgYW5kIGRvZXNuJ3QgYWRkIGFueSBhZGRpdGlvbmFsIHZvbHVtZXMuXG4gICAqXG4gICAqIEVhY2ggaW5zdGFuY2UgY2FuIGJlIHVzZWQgYnkgbXVsdGlwbGUgcnVubmVycywgc28gbWFrZSBzdXJlIHRoZXJlIGlzIGVub3VnaCBzcGFjZSBmb3IgYWxsIG9mIHRoZW0uXG4gICAqXG4gICAqIEBkZWZhdWx0IGRlZmF1bHQgc2l6ZSBmb3IgQU1JICh1c3VhbGx5IDMwR0IgZm9yIExpbnV4IGFuZCA1MEdCIGZvciBXaW5kb3dzKVxuICAgKi9cbiAgcmVhZG9ubHkgc3RvcmFnZVNpemU/OiBjZGsuU2l6ZTtcblxuICAvKipcbiAgICogT3B0aW9ucyBmb3IgcnVubmVyIGluc3RhbmNlIHN0b3JhZ2Ugdm9sdW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgc3RvcmFnZU9wdGlvbnM/OiBTdG9yYWdlT3B0aW9ucztcblxuICAvKipcbiAgICogU3VwcG9ydCBidWlsZGluZyBhbmQgcnVubmluZyBEb2NrZXIgaW1hZ2VzIGJ5IGVuYWJsaW5nIERvY2tlci1pbi1Eb2NrZXIgKGRpbmQpIGFuZCB0aGUgcmVxdWlyZWQgQ29kZUJ1aWxkIHByaXZpbGVnZWQgbW9kZS4gRGlzYWJsaW5nIHRoaXMgY2FuXG4gICAqIHNwZWVkIHVwIHByb3Zpc2lvbmluZyBvZiBDb2RlQnVpbGQgcnVubmVycy4gSWYgeW91IGRvbid0IGludGVuZCBvbiBydW5uaW5nIG9yIGJ1aWxkaW5nIERvY2tlciBpbWFnZXMsIGRpc2FibGUgdGhpcyBmb3IgZmFzdGVyIHN0YXJ0LXVwIHRpbWVzLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBkb2NrZXJJbkRvY2tlcj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFVzZSBzcG90IGNhcGFjaXR5LlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZSAodHJ1ZSBpZiBzcG90TWF4UHJpY2UgaXMgc3BlY2lmaWVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc3BvdD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE1heGltdW0gcHJpY2UgZm9yIHNwb3QgaW5zdGFuY2VzLlxuICAgKi9cbiAgcmVhZG9ubHkgc3BvdE1heFByaWNlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFQ1MgcGxhY2VtZW50IHN0cmF0ZWdpZXMgdG8gaW5mbHVlbmNlIHRhc2sgcGxhY2VtZW50LlxuICAgKlxuICAgKiBFeGFtcGxlOiBbZWNzLlBsYWNlbWVudFN0cmF0ZWd5LnBhY2tlZEJ5Q3B1KCldXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gcGxhY2VtZW50IHN0cmF0ZWdpZXMpXG4gICAqL1xuICByZWFkb25seSBwbGFjZW1lbnRTdHJhdGVnaWVzPzogZWNzLlBsYWNlbWVudFN0cmF0ZWd5W107XG5cbiAgLyoqXG4gICAqIEVDUyBwbGFjZW1lbnQgY29uc3RyYWludHMgdG8gaW5mbHVlbmNlIHRhc2sgcGxhY2VtZW50LlxuICAgKlxuICAgKiBFeGFtcGxlOiBbZWNzLlBsYWNlbWVudENvbnN0cmFpbnQubWVtYmVyT2YoJ2Vjcy1wbGFjZW1lbnQnKV1cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyBwbGFjZW1lbnQgY29uc3RyYWludHMpXG4gICAqL1xuICByZWFkb25seSBwbGFjZW1lbnRDb25zdHJhaW50cz86IGVjcy5QbGFjZW1lbnRDb25zdHJhaW50W107XG5cbiAgLyoqXG4gICAqIE51bWJlciBvZiBHUFVzIHRvIHJlcXVlc3QgZm9yIHRoZSBydW5uZXIgdGFzay4gV2hlbiBzZXQsIHRoZSB0YXNrIHdpbGwgYmUgc2NoZWR1bGVkIG9uIEdQVS1jYXBhYmxlIGluc3RhbmNlcy5cbiAgICpcbiAgICogUmVxdWlyZXMgYSBHUFUtY2FwYWJsZSBpbnN0YW5jZSB0eXBlIChlLmcuLCBnNGRuLnhsYXJnZSBmb3IgMSBHUFUsIGc0ZG4uMTJ4bGFyZ2UgZm9yIDQgR1BVcykgYW5kIEdQVSBBTUkuXG4gICAqIFdoZW4gY3JlYXRpbmcgYSBuZXcgY2x1c3RlciwgaW5zdGFuY2VUeXBlIGRlZmF1bHRzIHRvIGc0ZG4ueGxhcmdlIGFuZCB0aGUgRUNTIE9wdGltaXplZCBHUFUgQU1JIGlzIHVzZWQuXG4gICAqXG4gICAqIFlvdSBtdXN0IGVuc3VyZSB0aGF0IHRoZSB0YXNrJ3MgY29udGFpbmVyIGltYWdlIGluY2x1ZGVzIHRoZSBDVURBIHJ1bnRpbWUuIFByb3ZpZGUgYSBDVURBLWVuYWJsZWQgYmFzZSBpbWFnZVxuICAgKiB2aWEgYGJhc2VEb2NrZXJJbWFnZWAsIHVzZSBhbiBpbWFnZSBidWlsZGVyIHRoYXQgc3RhcnRzIGZyb20gYSBHUFUtY2FwYWJsZSBpbWFnZSAoc3VjaCBhcyBudmlkaWEvY3VkYSksIG9yIGFkZFxuICAgKiBhbiBpbWFnZSBjb21wb25lbnQgdGhhdCBpbnN0YWxscyB0aGUgQ1VEQSBydW50aW1lIGludG8gdGhlIGltYWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIEdQVSlcbiAgICovXG4gIHJlYWRvbmx5IGdwdT86IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEVjc0VjMkxhdW5jaFRhcmdldE9wdGlvbnMgZXh0ZW5kcyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc0VjMkxhdW5jaFRhcmdldE9wdGlvbnMge1xuICByZWFkb25seSBjYXBhY2l0eVByb3ZpZGVyOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ3VzdG9tIEVDUyBFQzIgbGF1bmNoIHRhcmdldCB0aGF0IGFsbG93cyBzcGVjaWZ5aW5nIGNhcGFjaXR5IHByb3ZpZGVyIHN0cmF0ZWd5IGFuZCBwcm9wYWdhdGluZyB0YWdzLlxuICovXG5jbGFzcyBDdXN0b21FY3NFYzJMYXVuY2hUYXJnZXQgZXh0ZW5kcyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc0VjMkxhdW5jaFRhcmdldCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2FwYWNpdHlQcm92aWRlcjogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IEVjc0VjMkxhdW5jaFRhcmdldE9wdGlvbnMpIHtcbiAgICBzdXBlcihvcHRpb25zKTtcbiAgICB0aGlzLmNhcGFjaXR5UHJvdmlkZXIgPSBvcHRpb25zLmNhcGFjaXR5UHJvdmlkZXI7XG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIHdoZW4gdGhlIEVDUyBsYXVuY2ggdHlwZSBjb25maWd1cmVkIG9uIFJ1blRhc2tcbiAgICovXG4gIHB1YmxpYyBiaW5kKF90YXNrOiBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc1J1blRhc2ssXG4gICAgX2xhdW5jaFRhcmdldE9wdGlvbnM6IHN0ZXBmdW5jdGlvbnNfdGFza3MuTGF1bmNoVGFyZ2V0QmluZE9wdGlvbnMpOiBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc0xhdW5jaFRhcmdldENvbmZpZyB7XG4gICAgY29uc3QgYmFzZSA9IHN1cGVyLmJpbmQoX3Rhc2ssIF9sYXVuY2hUYXJnZXRPcHRpb25zKTtcbiAgICByZXR1cm4ge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgLi4uKGJhc2UucGFyYW1ldGVycyA/PyB7fSksXG4gICAgICAgIFByb3BhZ2F0ZVRhZ3M6IGVjcy5Qcm9wYWdhdGVkVGFnU291cmNlLlRBU0tfREVGSU5JVElPTixcbiAgICAgICAgQ2FwYWNpdHlQcm92aWRlclN0cmF0ZWd5OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgQ2FwYWNpdHlQcm92aWRlcjogdGhpcy5jYXBhY2l0eVByb3ZpZGVyLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIExhdW5jaFR5cGU6IHVuZGVmaW5lZCwgLy8gWW91IG1heSBjaG9vc2UgYSBjYXBhY2l0eSBwcm92aWRlciBvciBhIGxhdW5jaCB0eXBlIGJ1dCBub3QgYm90aC5cbiAgICAgIH0sXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBwcm92aWRlciB1c2luZyBFQ1Mgb24gRUMyIHRvIGV4ZWN1dGUgam9icy5cbiAqXG4gKiBFQ1MgY2FuIGJlIHVzZWZ1bCB3aGVuIHlvdSB3YW50IG1vcmUgY29udHJvbCBvZiB0aGUgaW5mcmFzdHJ1Y3R1cmUgcnVubmluZyB0aGUgR2l0SHViIEFjdGlvbnMgRG9ja2VyIGNvbnRhaW5lcnMuIFlvdSBjYW4gY29udHJvbCB0aGUgYXV0b3NjYWxpbmdcbiAqIGdyb3VwIHRvIHNjYWxlIGRvd24gdG8gemVybyBkdXJpbmcgdGhlIG5pZ2h0IGFuZCBzY2FsZSB1cCBkdXJpbmcgd29yayBob3Vycy4gVGhpcyB3YXkgeW91IGNhbiBzdGlsbCBzYXZlIG1vbmV5LCBidXQgaGF2ZSB0byB3YWl0IGxlc3MgZm9yXG4gKiBpbmZyYXN0cnVjdHVyZSB0byBzcGluIHVwLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIG5vdCBtZWFudCB0byBiZSB1c2VkIGJ5IGl0c2VsZi4gSXQgc2hvdWxkIGJlIHBhc3NlZCBpbiB0aGUgcHJvdmlkZXJzIHByb3BlcnR5IGZvciBHaXRIdWJSdW5uZXJzLlxuICovXG5leHBvcnQgY2xhc3MgRWNzUnVubmVyUHJvdmlkZXIgZXh0ZW5kcyBCYXNlUHJvdmlkZXIgaW1wbGVtZW50cyBJUnVubmVyUHJvdmlkZXIge1xuICAvKipcbiAgICogQ3JlYXRlIG5ldyBpbWFnZSBidWlsZGVyIHRoYXQgYnVpbGRzIEVDUyBzcGVjaWZpYyBydW5uZXIgaW1hZ2VzLlxuICAgKlxuICAgKiBZb3UgY2FuIGN1c3RvbWl6ZSB0aGUgT1MsIGFyY2hpdGVjdHVyZSwgVlBDLCBzdWJuZXQsIHNlY3VyaXR5IGdyb3VwcywgZXRjLiBieSBwYXNzaW5nIGluIHByb3BzLlxuICAgKlxuICAgKiBZb3UgY2FuIGFkZCBjb21wb25lbnRzIHRvIHRoZSBpbWFnZSBidWlsZGVyIGJ5IGNhbGxpbmcgYGltYWdlQnVpbGRlci5hZGRDb21wb25lbnQoKWAuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IE9TIGlzIFVidW50dSBydW5uaW5nIG9uIHg2NCBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEluY2x1ZGVkIGNvbXBvbmVudHM6XG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5yZXF1aXJlZFBhY2thZ2VzKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5ydW5uZXJVc2VyKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXQoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YkNsaSgpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuYXdzQ2xpKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5kb2NrZXIoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YlJ1bm5lcigpYFxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBpbWFnZUJ1aWxkZXIoc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBSdW5uZXJJbWFnZUJ1aWxkZXJQcm9wcykge1xuICAgIHJldHVybiBSdW5uZXJJbWFnZUJ1aWxkZXIubmV3KHNjb3BlLCBpZCwge1xuICAgICAgb3M6IE9zLkxJTlVYX1VCVU5UVSxcbiAgICAgIGFyY2hpdGVjdHVyZTogQXJjaGl0ZWN0dXJlLlg4Nl82NCxcbiAgICAgIGNvbXBvbmVudHM6IFtcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQucmVxdWlyZWRQYWNrYWdlcygpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5ydW5uZXJVc2VyKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdCgpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXRodWJDbGkoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuYXdzQ2xpKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmRvY2tlcigpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXRodWJSdW5uZXIocHJvcHM/LnJ1bm5lclZlcnNpb24gPz8gUnVubmVyVmVyc2lvbi5sYXRlc3QoKSksXG4gICAgICBdLFxuICAgICAgLi4ucHJvcHMsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ2x1c3RlciBob3N0aW5nIHRoZSB0YXNrIGhvc3RpbmcgdGhlIHJ1bm5lci5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgY2x1c3RlcjogZWNzLkNsdXN0ZXI7XG5cbiAgLyoqXG4gICAqIENhcGFjaXR5IHByb3ZpZGVyIHVzZWQgdG8gc2NhbGUgdGhlIGNsdXN0ZXIuXG4gICAqXG4gICAqIFVzZSBjYXBhY2l0eVByb3ZpZGVyLmF1dG9TY2FsaW5nR3JvdXAgdG8gYWNjZXNzIHRoZSBhdXRvIHNjYWxpbmcgZ3JvdXAuIFRoaXMgY2FuIGhlbHAgc2V0IHVwIGN1c3RvbSBzY2FsaW5nIHBvbGljaWVzLlxuICAgKi9cbiAgcmVhZG9ubHkgY2FwYWNpdHlQcm92aWRlcjogZWNzLkFzZ0NhcGFjaXR5UHJvdmlkZXI7XG5cbiAgLyoqXG4gICAqIEVDUyB0YXNrIGhvc3RpbmcgdGhlIHJ1bm5lci5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgdGFzazogZWNzLkVjMlRhc2tEZWZpbml0aW9uO1xuXG4gIC8qKlxuICAgKiBDb250YWluZXIgZGVmaW5pdGlvbiBob3N0aW5nIHRoZSBydW5uZXIuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnRhaW5lcjogZWNzLkNvbnRhaW5lckRlZmluaXRpb247XG5cbiAgLyoqXG4gICAqIExhYmVscyBhc3NvY2lhdGVkIHdpdGggdGhpcyBwcm92aWRlci5cbiAgICovXG4gIHJlYWRvbmx5IGxhYmVsczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFZQQyB1c2VkIGZvciBob3N0aW5nIHRoZSBydW5uZXIgdGFzay5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG5cbiAgLyoqXG4gICAqIFN1Ym5ldHMgdXNlZCBmb3IgaG9zdGluZyB0aGUgcnVubmVyIHRhc2suXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHN1Ym5ldFNlbGVjdGlvbj86IGVjMi5TdWJuZXRTZWxlY3Rpb247XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcnVubmVyIHRhc2sgd2lsbCBoYXZlIGEgcHVibGljIElQLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBhc3NpZ25QdWJsaWNJcDogYm9vbGVhbjtcblxuICAvKipcbiAgICogR3JhbnQgcHJpbmNpcGFsIHVzZWQgdG8gYWRkIHBlcm1pc3Npb25zIHRvIHRoZSBydW5uZXIgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGdyYW50UHJpbmNpcGFsOiBpYW0uSVByaW5jaXBhbDtcblxuICAvKipcbiAgICogVGhlIG5ldHdvcmsgY29ubmVjdGlvbnMgYXNzb2NpYXRlZCB3aXRoIHRoaXMgcmVzb3VyY2UuXG4gICAqL1xuICByZWFkb25seSBjb25uZWN0aW9uczogZWMyLkNvbm5lY3Rpb25zO1xuXG4gIC8qKlxuICAgKiBEb2NrZXIgaW1hZ2UgbG9hZGVkIHdpdGggR2l0SHViIEFjdGlvbnMgUnVubmVyIGFuZCBpdHMgcHJlcmVxdWlzaXRlcy4gVGhlIGltYWdlIGlzIGJ1aWx0IGJ5IGFuIGltYWdlIGJ1aWxkZXIgYW5kIGlzIHNwZWNpZmljIHRvIEVDUyB0YXNrcy5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgaW1hZ2U6IFJ1bm5lckltYWdlO1xuXG4gIC8qKlxuICAgKiBMb2cgZ3JvdXAgd2hlcmUgcHJvdmlkZWQgcnVubmVycyB3aWxsIHNhdmUgdGhlaXIgbG9ncy5cbiAgICpcbiAgICogTm90ZSB0aGF0IHRoaXMgaXMgbm90IHRoZSBqb2IgbG9nLCBidXQgdGhlIHJ1bm5lciBpdHNlbGYuIEl0IHdpbGwgbm90IGNvbnRhaW4gb3V0cHV0IGZyb20gdGhlIEdpdEh1YiBBY3Rpb24gYnV0IG9ubHkgbWV0YWRhdGEgb24gaXRzIGV4ZWN1dGlvbi5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cDtcblxuICAvKipcbiAgICogU2VjdXJpdHkgZ3JvdXBzIGFzc29jaWF0ZWQgd2l0aCB0aGlzIHByb3ZpZGVyLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBzZWN1cml0eUdyb3VwczogZWMyLklTZWN1cml0eUdyb3VwW107XG5cbiAgLyoqXG4gICAqIFJ1biBkb2NrZXIgaW4gZG9ja2VyLlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBkaW5kOiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSdW5uZXIgZ3JvdXAgbmFtZS5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgZ3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEluY2x1ZGUgZGVmYXVsdCBsYWJlbHMgKGFyY2gsIG9zLCBzZWxmLWhvc3RlZCkgZm9yIHJ1bm5lci5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgZGVmYXVsdExhYmVsczogYm9vbGVhbjtcblxuICAvKipcbiAgICogRUNTIHBsYWNlbWVudCBzdHJhdGVnaWVzIHRvIGluZmx1ZW5jZSB0YXNrIHBsYWNlbWVudC5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgcGxhY2VtZW50U3RyYXRlZ2llcz86IGVjcy5QbGFjZW1lbnRTdHJhdGVneVtdO1xuXG4gIC8qKlxuICAgKiBFQ1MgcGxhY2VtZW50IGNvbnN0cmFpbnRzIHRvIGluZmx1ZW5jZSB0YXNrIHBsYWNlbWVudC5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgcGxhY2VtZW50Q29uc3RyYWludHM/OiBlY3MuUGxhY2VtZW50Q29uc3RyYWludFtdO1xuXG4gIC8qKlxuICAgKiBOdW1iZXIgb2YgR1BVcyByZXF1ZXN0ZWQgZm9yIHRoZSBydW5uZXIgdGFzayAoMCA9IG5vIEdQVSkuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGdwdUNvdW50OiBudW1iZXI7XG5cbiAgcmVhZG9ubHkgcmV0cnlhYmxlRXJyb3JzID0gW1xuICAgICdFY3MuRWNzRXhjZXB0aW9uJyxcbiAgICAnRUNTLkFtYXpvbkVDU0V4Y2VwdGlvbicsXG4gICAgJ0Vjcy5MaW1pdEV4Y2VlZGVkRXhjZXB0aW9uJyxcbiAgICAnRWNzLlVwZGF0ZUluUHJvZ3Jlc3NFeGNlcHRpb24nLFxuICBdO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogRWNzUnVubmVyUHJvdmlkZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgdGhpcy5sYWJlbHMgPSBwcm9wcz8ubGFiZWxzID8/IFsnZWNzJ107XG4gICAgdGhpcy5ncm91cCA9IHByb3BzPy5ncm91cDtcbiAgICB0aGlzLmRlZmF1bHRMYWJlbHMgPSBwcm9wcz8uZGVmYXVsdExhYmVscyA/PyB0cnVlO1xuICAgIHRoaXMudnBjID0gcHJvcHM/LnZwYyA/PyBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgJ2RlZmF1bHQgdnBjJywgeyBpc0RlZmF1bHQ6IHRydWUgfSk7XG4gICAgdGhpcy5zdWJuZXRTZWxlY3Rpb24gPSBwcm9wcz8uc3VibmV0U2VsZWN0aW9uO1xuICAgIHRoaXMuc2VjdXJpdHlHcm91cHMgPSBwcm9wcz8uc2VjdXJpdHlHcm91cHMgPz8gW25ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnc2VjdXJpdHkgZ3JvdXAnLCB7IHZwYzogdGhpcy52cGMgfSldO1xuICAgIHRoaXMuY29ubmVjdGlvbnMgPSBuZXcgZWMyLkNvbm5lY3Rpb25zKHsgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHMgfSk7XG4gICAgdGhpcy5hc3NpZ25QdWJsaWNJcCA9IHByb3BzPy5hc3NpZ25QdWJsaWNJcCA/PyB0cnVlO1xuICAgIHRoaXMucGxhY2VtZW50U3RyYXRlZ2llcyA9IHByb3BzPy5wbGFjZW1lbnRTdHJhdGVnaWVzO1xuICAgIHRoaXMucGxhY2VtZW50Q29uc3RyYWludHMgPSBwcm9wcz8ucGxhY2VtZW50Q29uc3RyYWludHM7XG4gICAgdGhpcy5ncHVDb3VudCA9IHByb3BzPy5ncHUgPz8gMDtcbiAgICB0aGlzLmNsdXN0ZXIgPSBwcm9wcz8uY2x1c3RlciA/IHByb3BzLmNsdXN0ZXIgOiBuZXcgZWNzLkNsdXN0ZXIoXG4gICAgICB0aGlzLFxuICAgICAgJ2NsdXN0ZXInLFxuICAgICAge1xuICAgICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgICBlbmFibGVGYXJnYXRlQ2FwYWNpdHlQcm92aWRlcnM6IGZhbHNlLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgaWYgKHByb3BzPy5zdG9yYWdlT3B0aW9ucyAmJiAhcHJvcHM/LnN0b3JhZ2VTaXplKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3N0b3JhZ2VTaXplIGlzIHJlcXVpcmVkIHdoZW4gc3RvcmFnZU9wdGlvbnMgYXJlIHNwZWNpZmllZCcpO1xuICAgIH1cblxuICAgIGNvbnN0IGRlZmF1bHRJbWFnZUJ1aWxkZXJBcmNoaXRlY3R1cmUgPVxuICAgICAgIXByb3BzPy5jYXBhY2l0eVByb3ZpZGVyICYmIHByb3BzPy5pbnN0YW5jZVR5cGU/LmFyY2hpdGVjdHVyZSA9PT0gZWMyLkluc3RhbmNlQXJjaGl0ZWN0dXJlLkFSTV82NFxuICAgICAgICA/IEFyY2hpdGVjdHVyZS5BUk02NFxuICAgICAgICA6IEFyY2hpdGVjdHVyZS5YODZfNjQ7XG5cbiAgICBjb25zdCBpbWFnZUJ1aWxkZXIgPSBwcm9wcz8uaW1hZ2VCdWlsZGVyID8/IEVjc1J1bm5lclByb3ZpZGVyLmltYWdlQnVpbGRlcih0aGlzLCAnSW1hZ2UgQnVpbGRlcicsIHtcbiAgICAgIGFyY2hpdGVjdHVyZTogZGVmYXVsdEltYWdlQnVpbGRlckFyY2hpdGVjdHVyZSxcbiAgICB9KTtcbiAgICBjb25zdCBpbWFnZSA9IHRoaXMuaW1hZ2UgPSBpbWFnZUJ1aWxkZXIuYmluZERvY2tlckltYWdlKCk7XG5cbiAgICBpZiAocHJvcHM/LmNhcGFjaXR5UHJvdmlkZXIpIHtcbiAgICAgIGlmIChwcm9wcz8ubWluSW5zdGFuY2VzIHx8IHByb3BzPy5tYXhJbnN0YW5jZXMgfHwgcHJvcHM/Lmluc3RhbmNlVHlwZSB8fCBwcm9wcz8uc3RvcmFnZVNpemUgfHwgcHJvcHM/LnNwb3QgfHwgcHJvcHM/LnNwb3RNYXhQcmljZSkge1xuICAgICAgICBjZGsuQW5ub3RhdGlvbnMub2YodGhpcykuYWRkV2FybmluZygnV2hlbiB1c2luZyBhIGN1c3RvbSBjYXBhY2l0eSBwcm92aWRlciwgbWluSW5zdGFuY2VzLCBtYXhJbnN0YW5jZXMsIGluc3RhbmNlVHlwZSwgc3RvcmFnZVNpemUsIHNwb3QsIGFuZCBzcG90TWF4UHJpY2Ugd2lsbCBiZSBpZ25vcmVkLicpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmNhcGFjaXR5UHJvdmlkZXIgPSBwcm9wcy5jYXBhY2l0eVByb3ZpZGVyO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzcG90ID0gcHJvcHM/LnNwb3QgPz8gcHJvcHM/LnNwb3RNYXhQcmljZSAhPT0gdW5kZWZpbmVkO1xuXG4gICAgICBjb25zdCBsYXVuY2hUZW1wbGF0ZSA9IG5ldyBlYzIuTGF1bmNoVGVtcGxhdGUodGhpcywgJ0xhdW5jaCBUZW1wbGF0ZScsIHtcbiAgICAgICAgbWFjaGluZUltYWdlOiB0aGlzLmRlZmF1bHRDbHVzdGVySW5zdGFuY2VBbWkoKSxcbiAgICAgICAgaW5zdGFuY2VUeXBlOiBwcm9wcz8uaW5zdGFuY2VUeXBlID8/IHRoaXMuZGVmYXVsdENsdXN0ZXJJbnN0YW5jZVR5cGUoKSxcbiAgICAgICAgYmxvY2tEZXZpY2VzOiBwcm9wcz8uc3RvcmFnZVNpemUgPyBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgZGV2aWNlTmFtZTogYW1pUm9vdERldmljZSh0aGlzLCB0aGlzLmRlZmF1bHRDbHVzdGVySW5zdGFuY2VBbWkoKS5nZXRJbWFnZSh0aGlzKS5pbWFnZUlkKS5yZWYsXG4gICAgICAgICAgICB2b2x1bWU6IHtcbiAgICAgICAgICAgICAgZWJzRGV2aWNlOiB7XG4gICAgICAgICAgICAgICAgZGVsZXRlT25UZXJtaW5hdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgICB2b2x1bWVTaXplOiBwcm9wcy5zdG9yYWdlU2l6ZS50b0dpYmlieXRlcygpLFxuICAgICAgICAgICAgICAgIHZvbHVtZVR5cGU6IHByb3BzLnN0b3JhZ2VPcHRpb25zPy52b2x1bWVUeXBlLFxuICAgICAgICAgICAgICAgIGlvcHM6IHByb3BzLnN0b3JhZ2VPcHRpb25zPy5pb3BzLFxuICAgICAgICAgICAgICAgIHRocm91Z2hwdXQ6IHByb3BzLnN0b3JhZ2VPcHRpb25zPy50aHJvdWdocHV0LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdIDogdW5kZWZpbmVkLFxuICAgICAgICBzcG90T3B0aW9uczogc3BvdCA/IHtcbiAgICAgICAgICByZXF1ZXN0VHlwZTogZWMyLlNwb3RSZXF1ZXN0VHlwZS5PTkVfVElNRSxcbiAgICAgICAgICBtYXhQcmljZTogcHJvcHM/LnNwb3RNYXhQcmljZSA/IHBhcnNlRmxvYXQocHJvcHM/LnNwb3RNYXhQcmljZSkgOiB1bmRlZmluZWQsXG4gICAgICAgIH0gOiB1bmRlZmluZWQsXG4gICAgICAgIHJlcXVpcmVJbWRzdjI6IHRydWUsXG4gICAgICAgIHNlY3VyaXR5R3JvdXA6IHRoaXMuc2VjdXJpdHlHcm91cHNbMF0sXG4gICAgICAgIHJvbGU6IG5ldyBpYW0uUm9sZSh0aGlzLCAnTGF1bmNoIFRlbXBsYXRlIFJvbGUnLCB7XG4gICAgICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2VjMi5hbWF6b25hd3MuY29tJyksXG4gICAgICAgIH0pLFxuICAgICAgICB1c2VyRGF0YTogZWMyLlVzZXJEYXRhLmZvck9wZXJhdGluZ1N5c3RlbShpbWFnZS5vcy5pcyhPcy5XSU5ET1dTKSA/IGVjMi5PcGVyYXRpbmdTeXN0ZW1UeXBlLldJTkRPV1MgOiBlYzIuT3BlcmF0aW5nU3lzdGVtVHlwZS5MSU5VWCksXG4gICAgICB9KTtcbiAgICAgIHRoaXMuc2VjdXJpdHlHcm91cHMuc2xpY2UoMSkubWFwKHNnID0+IGxhdW5jaFRlbXBsYXRlLmNvbm5lY3Rpb25zLmFkZFNlY3VyaXR5R3JvdXAoc2cpKTtcblxuICAgICAgY29uc3QgYXV0b1NjYWxpbmdHcm91cCA9IG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsICdBdXRvIFNjYWxpbmcgR3JvdXAnLCB7XG4gICAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICAgIGxhdW5jaFRlbXBsYXRlLFxuICAgICAgICB2cGNTdWJuZXRzOiB0aGlzLnN1Ym5ldFNlbGVjdGlvbixcbiAgICAgICAgbWluQ2FwYWNpdHk6IHByb3BzPy5taW5JbnN0YW5jZXMgPz8gMCxcbiAgICAgICAgbWF4Q2FwYWNpdHk6IHByb3BzPy5tYXhJbnN0YW5jZXMgPz8gNSxcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLmNhcGFjaXR5UHJvdmlkZXIgPSBwcm9wcz8uY2FwYWNpdHlQcm92aWRlciA/PyBuZXcgZWNzLkFzZ0NhcGFjaXR5UHJvdmlkZXIodGhpcywgJ0NhcGFjaXR5IFByb3ZpZGVyJywge1xuICAgICAgICBhdXRvU2NhbGluZ0dyb3VwLFxuICAgICAgICBzcG90SW5zdGFuY2VEcmFpbmluZzogZmFsc2UsIC8vIHdhc3RlIG9mIG1vbmV5IHRvIHJlc3RhcnQgam9icyBhcyB0aGUgcmVzdGFydGVkIGpvYiB3b24ndCBoYXZlIGEgdG9rZW5cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHRoaXMuY2FwYWNpdHlQcm92aWRlci5hdXRvU2NhbGluZ0dyb3VwLmFkZFVzZXJEYXRhKFxuICAgICAgLy8gd2UgZG9uJ3QgZXhpdCBvbiBlcnJvcnMgYmVjYXVzZSBhbGwgb2YgdGhlc2UgY29tbWFuZHMgYXJlIG9wdGlvbmFsXG4gICAgICAuLi50aGlzLmxvZ2luQ29tbWFuZHMoKSxcbiAgICAgIHRoaXMucHVsbENvbW1hbmQoKSxcbiAgICAgIC4uLnRoaXMuZWNzU2V0dGluZ3NDb21tYW5kcygpLFxuICAgICk7XG4gICAgdGhpcy5jYXBhY2l0eVByb3ZpZGVyLmF1dG9TY2FsaW5nR3JvdXAucm9sZS5hZGRUb1ByaW5jaXBhbFBvbGljeShNSU5JTUFMX0VDMl9TU01fU0VTU0lPTl9NQU5BR0VSX1BPTElDWV9TVEFURU1FTlQpO1xuICAgIGltYWdlLmltYWdlUmVwb3NpdG9yeS5ncmFudFB1bGwodGhpcy5jYXBhY2l0eVByb3ZpZGVyLmF1dG9TY2FsaW5nR3JvdXApO1xuXG4gICAgdGhpcy5jbHVzdGVyLmFkZEFzZ0NhcGFjaXR5UHJvdmlkZXIoXG4gICAgICB0aGlzLmNhcGFjaXR5UHJvdmlkZXIsXG4gICAgICB7XG4gICAgICAgIHNwb3RJbnN0YW5jZURyYWluaW5nOiBmYWxzZSxcbiAgICAgICAgbWFjaGluZUltYWdlVHlwZTogTWFjaGluZUltYWdlVHlwZS5BTUFaT05fTElOVVhfMixcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHRoaXMubG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnbG9ncycsIHtcbiAgICAgIHJldGVudGlvbjogcHJvcHM/LmxvZ1JldGVudGlvbiA/PyBSZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIHRoaXMuZGluZCA9IChwcm9wcz8uZG9ja2VySW5Eb2NrZXIgPz8gdHJ1ZSkgJiYgIWltYWdlLm9zLmlzKE9zLldJTkRPV1MpO1xuXG4gICAgdGhpcy50YXNrID0gbmV3IGVjcy5FYzJUYXNrRGVmaW5pdGlvbih0aGlzLCAndGFzaycpO1xuICAgIHRoaXMuY29udGFpbmVyID0gdGhpcy50YXNrLmFkZENvbnRhaW5lcihcbiAgICAgICdydW5uZXInLFxuICAgICAge1xuICAgICAgICBpbWFnZTogZWNzLkFzc2V0SW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoaW1hZ2UuaW1hZ2VSZXBvc2l0b3J5LCBpbWFnZS5pbWFnZVRhZyksXG4gICAgICAgIGNwdTogcHJvcHM/LmNwdSA/PyAxMDI0LFxuICAgICAgICBtZW1vcnlMaW1pdE1pQjogcHJvcHM/Lm1lbW9yeUxpbWl0TWlCID8/IChwcm9wcz8ubWVtb3J5UmVzZXJ2YXRpb25NaUIgPyB1bmRlZmluZWQgOiAzNTAwKSxcbiAgICAgICAgbWVtb3J5UmVzZXJ2YXRpb25NaUI6IHByb3BzPy5tZW1vcnlSZXNlcnZhdGlvbk1pQixcbiAgICAgICAgZ3B1Q291bnQ6IHRoaXMuZ3B1Q291bnQgPiAwID8gdGhpcy5ncHVDb3VudCA6IHVuZGVmaW5lZCxcbiAgICAgICAgbG9nZ2luZzogZWNzLkF3c0xvZ0RyaXZlci5hd3NMb2dzKHtcbiAgICAgICAgICBsb2dHcm91cDogdGhpcy5sb2dHcm91cCxcbiAgICAgICAgICBzdHJlYW1QcmVmaXg6ICdydW5uZXInLFxuICAgICAgICB9KSxcbiAgICAgICAgY29tbWFuZDogZWNzUnVuQ29tbWFuZCh0aGlzLmltYWdlLm9zLCB0aGlzLmRpbmQpLFxuICAgICAgICB1c2VyOiBpbWFnZS5vcy5pcyhPcy5XSU5ET1dTKSA/IHVuZGVmaW5lZCA6ICdydW5uZXInLFxuICAgICAgICBwcml2aWxlZ2VkOiB0aGlzLmRpbmQsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICB0aGlzLmdyYW50UHJpbmNpcGFsID0gdGhpcy50YXNrLnRhc2tSb2xlO1xuXG4gICAgLy8gcGVybWlzc2lvbnMgZm9yIFNTTSBTZXNzaW9uIE1hbmFnZXJcbiAgICB0aGlzLnRhc2sudGFza1JvbGUuYWRkVG9QcmluY2lwYWxQb2xpY3koTUlOSU1BTF9FQ1NfU1NNX1NFU1NJT05fTUFOQUdFUl9QT0xJQ1lfU1RBVEVNRU5UKTtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdENsdXN0ZXJJbnN0YW5jZVR5cGUoKSB7XG4gICAgaWYgKHRoaXMuZ3B1Q291bnQgPiAwKSB7XG4gICAgICBpZiAoIXRoaXMuaW1hZ2UuYXJjaGl0ZWN0dXJlLmlzKEFyY2hpdGVjdHVyZS5YODZfNjQpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignRUNTIEdQVSBpcyBvbmx5IHN1cHBvcnRlZCBmb3IgeDY0IGFyY2hpdGVjdHVyZS4gR1BVIGluc3RhbmNlcyAoZzRkbiwgZzUsIHAzLCBldGMuKSBhcmUgeDY0IG9ubHkuJyk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5ncHVDb3VudCA8PSAxKSB7XG4gICAgICAgIHJldHVybiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLkc0RE4sIGVjMi5JbnN0YW5jZVNpemUuWExBUkdFKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLmdwdUNvdW50IDw9IDQpIHtcbiAgICAgICAgcmV0dXJuIGVjMi5JbnN0YW5jZVR5cGUub2YoZWMyLkluc3RhbmNlQ2xhc3MuRzRETiwgZWMyLkluc3RhbmNlU2l6ZS5YTEFSR0UxMik7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5ncHVDb3VudCA8PSA4KSB7XG4gICAgICAgIHJldHVybiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLlAzLCBlYzIuSW5zdGFuY2VTaXplLlhMQVJHRTE2KTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgR1BVIGNvdW50OiAke3RoaXMuZ3B1Q291bnR9YCk7XG4gICAgfVxuICAgIGlmICh0aGlzLmltYWdlLmFyY2hpdGVjdHVyZS5pcyhBcmNoaXRlY3R1cmUuWDg2XzY0KSkge1xuICAgICAgcmV0dXJuIGVjMi5JbnN0YW5jZVR5cGUub2YoZWMyLkluc3RhbmNlQ2xhc3MuTTZJLCBlYzIuSW5zdGFuY2VTaXplLkxBUkdFKTtcbiAgICB9XG4gICAgaWYgKHRoaXMuaW1hZ2UuYXJjaGl0ZWN0dXJlLmlzKEFyY2hpdGVjdHVyZS5BUk02NCkpIHtcbiAgICAgIHJldHVybiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLk02RywgZWMyLkluc3RhbmNlU2l6ZS5MQVJHRSk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIGZpbmQgaW5zdGFuY2UgdHlwZSBmb3IgRUNTIGluc3RhbmNlcyBmb3IgJHt0aGlzLmltYWdlLmFyY2hpdGVjdHVyZS5uYW1lfWApO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0Q2x1c3Rlckluc3RhbmNlQW1pKCkge1xuICAgIGxldCBiYXNlSW1hZ2U6IGVjMi5JTWFjaGluZUltYWdlO1xuICAgIGxldCBzc21QYXRoOiBzdHJpbmc7XG4gICAgbGV0IGZvdW5kID0gZmFsc2U7XG5cbiAgICBpZiAodGhpcy5pbWFnZS5vcy5pc0luKE9zLl9BTExfTElOVVhfVkVSU0lPTlMpKSB7XG4gICAgICBpZiAodGhpcy5ncHVDb3VudCA+IDAgJiYgdGhpcy5pbWFnZS5hcmNoaXRlY3R1cmUuaXMoQXJjaGl0ZWN0dXJlLlg4Nl82NCkpIHtcbiAgICAgICAgYmFzZUltYWdlID0gZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MjAyMyhlY3MuQW1pSGFyZHdhcmVUeXBlLkdQVSk7XG4gICAgICAgIHNzbVBhdGggPSAnL2F3cy9zZXJ2aWNlL2Vjcy9vcHRpbWl6ZWQtYW1pL2FtYXpvbi1saW51eC0yMDIzL2dwdS9yZWNvbW1lbmRlZC9pbWFnZV9pZCc7XG4gICAgICAgIGZvdW5kID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5pbWFnZS5hcmNoaXRlY3R1cmUuaXMoQXJjaGl0ZWN0dXJlLlg4Nl82NCkpIHtcbiAgICAgICAgYmFzZUltYWdlID0gZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MjAyMyhlY3MuQW1pSGFyZHdhcmVUeXBlLlNUQU5EQVJEKTtcbiAgICAgICAgc3NtUGF0aCA9ICcvYXdzL3NlcnZpY2UvZWNzL29wdGltaXplZC1hbWkvYW1hem9uLWxpbnV4LTIwMjMvcmVjb21tZW5kZWQvaW1hZ2VfaWQnO1xuICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICB9IGVsc2UgaWYgKHRoaXMuaW1hZ2UuYXJjaGl0ZWN0dXJlLmlzKEFyY2hpdGVjdHVyZS5BUk02NCkpIHtcbiAgICAgICAgYmFzZUltYWdlID0gZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MjAyMyhlY3MuQW1pSGFyZHdhcmVUeXBlLkFSTSk7XG4gICAgICAgIHNzbVBhdGggPSAnL2F3cy9zZXJ2aWNlL2Vjcy9vcHRpbWl6ZWQtYW1pL2FtYXpvbi1saW51eC0yMDIzL2FybTY0L3JlY29tbWVuZGVkL2ltYWdlX2lkJztcbiAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLmltYWdlLm9zLmlzKE9zLldJTkRPV1MpKSB7XG4gICAgICBiYXNlSW1hZ2UgPSBlY3MuRWNzT3B0aW1pemVkSW1hZ2Uud2luZG93cyhlY3MuV2luZG93c09wdGltaXplZFZlcnNpb24uU0VSVkVSXzIwMTkpO1xuICAgICAgc3NtUGF0aCA9ICcvYXdzL3NlcnZpY2UvYW1pLXdpbmRvd3MtbGF0ZXN0L1dpbmRvd3NfU2VydmVyLTIwMTktRW5nbGlzaC1GdWxsLUVDU19PcHRpbWl6ZWQvaW1hZ2VfaWQnO1xuICAgICAgZm91bmQgPSB0cnVlO1xuICAgIH1cblxuICAgIGlmICghZm91bmQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIGZpbmQgQU1JIGZvciBFQ1MgaW5zdGFuY2VzIGZvciAke3RoaXMuaW1hZ2Uub3MubmFtZX0vJHt0aGlzLmltYWdlLmFyY2hpdGVjdHVyZS5uYW1lfSAoZ3B1Q291bnQ9JHt0aGlzLmdwdUNvdW50fSlgKTtcbiAgICB9XG5cbiAgICBjb25zdCBpbWFnZTogZWMyLklNYWNoaW5lSW1hZ2UgPSB7XG4gICAgICBnZXRJbWFnZShzY29wZTogQ29uc3RydWN0KTogZWMyLk1hY2hpbmVJbWFnZUNvbmZpZyB7XG4gICAgICAgIGNvbnN0IGJhc2VJbWFnZVJlcyA9IGJhc2VJbWFnZS5nZXRJbWFnZShzY29wZSk7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpbWFnZUlkOiBgcmVzb2x2ZTpzc206JHtzc21QYXRofWAsXG4gICAgICAgICAgdXNlckRhdGE6IGJhc2VJbWFnZVJlcy51c2VyRGF0YSxcbiAgICAgICAgICBvc1R5cGU6IGJhc2VJbWFnZVJlcy5vc1R5cGUsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgIH07XG5cbiAgICByZXR1cm4gaW1hZ2U7XG4gIH1cblxuICBwcml2YXRlIHB1bGxDb21tYW5kKCkge1xuICAgIGlmICh0aGlzLmltYWdlLm9zLmlzKE9zLldJTkRPV1MpKSB7XG4gICAgICByZXR1cm4gYFN0YXJ0LUpvYiAtU2NyaXB0QmxvY2sgeyBkb2NrZXIgcHVsbCAke3RoaXMuaW1hZ2UuaW1hZ2VSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OiR7dGhpcy5pbWFnZS5pbWFnZVRhZ30gfWA7XG4gICAgfVxuICAgIHJldHVybiBgZG9ja2VyIHB1bGwgJHt0aGlzLmltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfToke3RoaXMuaW1hZ2UuaW1hZ2VUYWd9ICZgO1xuICB9XG5cbiAgcHJpdmF0ZSBsb2dpbkNvbW1hbmRzKCkge1xuICAgIGNvbnN0IHRoaXNTdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGlmICh0aGlzLmltYWdlLm9zLmlzKE9zLldJTkRPV1MpKSB7XG4gICAgICByZXR1cm4gW2AoR2V0LUVDUkxvZ2luQ29tbWFuZCkuUGFzc3dvcmQgfCBkb2NrZXIgbG9naW4gLS11c2VybmFtZSBBV1MgLS1wYXNzd29yZC1zdGRpbiAke3RoaXNTdGFjay5hY2NvdW50fS5ka3IuZWNyLiR7dGhpc1N0YWNrLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWBdO1xuICAgIH1cbiAgICByZXR1cm4gW1xuICAgICAgJ3l1bSBpbnN0YWxsIC15IGF3c2NsaSB8fCBkbmYgaW5zdGFsbCAteSBhd3NjbGknLFxuICAgICAgYGF3cyBlY3IgZ2V0LWxvZ2luLXBhc3N3b3JkIC0tcmVnaW9uICR7dGhpc1N0YWNrLnJlZ2lvbn0gfCBkb2NrZXIgbG9naW4gLS11c2VybmFtZSBBV1MgLS1wYXNzd29yZC1zdGRpbiAke3RoaXNTdGFjay5hY2NvdW50fS5ka3IuZWNyLiR7dGhpc1N0YWNrLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgXTtcbiAgfVxuXG4gIHByaXZhdGUgZWNzU2V0dGluZ3NDb21tYW5kcygpIHtcbiAgICAvLyBkb24ndCBsZXQgRUNTIGFjY3VtdWxhdGUgdG9vIG1hbnkgc3RvcHBlZCB0YXNrcyB0aGF0IGNhbiBlbmQgdXAgdmVyeSBiaWcgaW4gb3VyIGNhc2VcbiAgICAvLyB0aGUgZGVmYXVsdCBpcyAxMG0gZHVyYXRpb24gd2l0aCAxaCBqaXR0ZXIgd2hpY2ggY2FuIGVuZCB1cCB3aXRoIDFoMTBtIGRlbGF5IGZvciBjbGVhbmluZyB1cCBzdG9wcGVkIHRhc2tzXG4gICAgaWYgKHRoaXMuaW1hZ2Uub3MuaXMoT3MuV0lORE9XUykpIHtcbiAgICAgIHJldHVybiBbXG4gICAgICAgICdbRW52aXJvbm1lbnRdOjpTZXRFbnZpcm9ubWVudFZhcmlhYmxlKFwiRUNTX0VOR0lORV9UQVNLX0NMRUFOVVBfV0FJVF9EVVJBVElPTlwiLCBcIjVzXCIsIFwiTWFjaGluZVwiKScsXG4gICAgICAgICdbRW52aXJvbm1lbnRdOjpTZXRFbnZpcm9ubWVudFZhcmlhYmxlKFwiRUNTX0VOR0lORV9UQVNLX0NMRUFOVVBfV0FJVF9EVVJBVElPTl9KSVRURVJcIiwgXCI1c1wiLCBcIk1hY2hpbmVcIiknLFxuICAgICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vYXdzL2F3cy1jZGsvaXNzdWVzLzM2ODA1XG4gICAgICAgICdbRW52aXJvbm1lbnRdOjpTZXRFbnZpcm9ubWVudFZhcmlhYmxlKFwiRUNTX0VOQUJMRV9UQVNLX0lBTV9ST0xFXCIsIFwidHJ1ZVwiLCBcIk1hY2hpbmVcIiknLFxuICAgICAgXTtcbiAgICB9XG4gICAgcmV0dXJuIFtcbiAgICAgICdlY2hvIEVDU19FTkdJTkVfVEFTS19DTEVBTlVQX1dBSVRfRFVSQVRJT049NXMgPj4gL2V0Yy9lY3MvZWNzLmNvbmZpZycsXG4gICAgICAnZWNobyBFQ1NfRU5HSU5FX1RBU0tfQ0xFQU5VUF9XQUlUX0RVUkFUSU9OX0pJVFRFUj01cyA+PiAvZXRjL2Vjcy9lY3MuY29uZmlnJyxcbiAgICBdO1xuICB9XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlIHN0ZXAgZnVuY3Rpb24gdGFzayhzKSB0byBzdGFydCBhIG5ldyBydW5uZXIuXG4gICAqXG4gICAqIENhbGxlZCBieSBHaXRodWJSdW5uZXJzIGFuZCBzaG91bGRuJ3QgYmUgY2FsbGVkIG1hbnVhbGx5LlxuICAgKlxuICAgKiBAcGFyYW0gcGFyYW1ldGVycyB3b3JrZmxvdyBqb2IgZGV0YWlsc1xuICAgKi9cbiAgZ2V0U3RlcEZ1bmN0aW9uVGFzayhwYXJhbWV0ZXJzOiBSdW5uZXJSdW50aW1lUGFyYW1ldGVycyk6IHN0ZXBmdW5jdGlvbnMuSUNoYWluYWJsZSB7XG4gICAgcmV0dXJuIG5ldyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc1J1blRhc2soXG4gICAgICB0aGlzLFxuICAgICAgJ1N0YXRlJyxcbiAgICAgIHtcbiAgICAgICAgc3RhdGVOYW1lOiBnZW5lcmF0ZVN0YXRlTmFtZSh0aGlzKSxcbiAgICAgICAgaW50ZWdyYXRpb25QYXR0ZXJuOiBJbnRlZ3JhdGlvblBhdHRlcm4uUlVOX0pPQiwgLy8gc3luY1xuICAgICAgICB0YXNrRGVmaW5pdGlvbjogdGhpcy50YXNrLFxuICAgICAgICBjbHVzdGVyOiB0aGlzLmNsdXN0ZXIsXG4gICAgICAgIGxhdW5jaFRhcmdldDogbmV3IEN1c3RvbUVjc0VjMkxhdW5jaFRhcmdldCh7XG4gICAgICAgICAgY2FwYWNpdHlQcm92aWRlcjogdGhpcy5jYXBhY2l0eVByb3ZpZGVyLmNhcGFjaXR5UHJvdmlkZXJOYW1lLFxuICAgICAgICAgIHBsYWNlbWVudFN0cmF0ZWdpZXM6IHRoaXMucGxhY2VtZW50U3RyYXRlZ2llcyxcbiAgICAgICAgICBwbGFjZW1lbnRDb25zdHJhaW50czogdGhpcy5wbGFjZW1lbnRDb25zdHJhaW50cyxcbiAgICAgICAgfSksXG4gICAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0aGlzLmltYWdlLm9zLmlzSW4oT3MuX0FMTF9MSU5VWF9WRVJTSU9OUyksXG4gICAgICAgIGFzc2lnblB1YmxpY0lwOiB0aGlzLmFzc2lnblB1YmxpY0lwLFxuICAgICAgICBjb250YWluZXJPdmVycmlkZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjb250YWluZXJEZWZpbml0aW9uOiB0aGlzLmNvbnRhaW5lcixcbiAgICAgICAgICAgIGVudmlyb25tZW50OiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUlVOTkVSX1RPS0VOJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogcGFyYW1ldGVycy5ydW5uZXJUb2tlblBhdGgsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUlVOTkVSX05BTUUnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBwYXJhbWV0ZXJzLnJ1bm5lck5hbWVQYXRoLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ1JVTk5FUl9MQUJFTCcsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMubGFiZWxzUGF0aCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5hbWU6ICdSVU5ORVJfR1JPVVAxJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogdGhpcy5ncm91cCA/ICctLXJ1bm5lcmdyb3VwJyA6ICcnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ1JVTk5FUl9HUk9VUDInLFxuICAgICAgICAgICAgICAgIHZhbHVlOiB0aGlzLmdyb3VwID8gdGhpcy5ncm91cCA6ICcnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ0RFRkFVTFRfTEFCRUxTJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogdGhpcy5kZWZhdWx0TGFiZWxzID8gJycgOiAnLS1uby1kZWZhdWx0LWxhYmVscycsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnR0lUSFVCX0RPTUFJTicsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMuZ2l0aHViRG9tYWluUGF0aCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5hbWU6ICdPV05FUicsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMub3duZXJQYXRoLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ1JFUE8nLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBwYXJhbWV0ZXJzLnJlcG9QYXRoLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ1JFR0lTVFJBVElPTl9VUkwnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBwYXJhbWV0ZXJzLnJlZ2lzdHJhdGlvblVybCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuXG4gIGdyYW50U3RhdGVNYWNoaW5lKF86IGlhbS5JR3JhbnRhYmxlKSB7XG4gIH1cblxuICBzdGF0dXMoc3RhdHVzRnVuY3Rpb25Sb2xlOiBpYW0uSUdyYW50YWJsZSk6IElSdW5uZXJQcm92aWRlclN0YXR1cyB7XG4gICAgdGhpcy5pbWFnZS5pbWFnZVJlcG9zaXRvcnkuZ3JhbnQoc3RhdHVzRnVuY3Rpb25Sb2xlLCAnZWNyOkRlc2NyaWJlSW1hZ2VzJyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgdHlwZTogdGhpcy5jb25zdHJ1Y3Rvci5uYW1lLFxuICAgICAgbGFiZWxzOiB0aGlzLmxhYmVscyxcbiAgICAgIGNvbnN0cnVjdFBhdGg6IHRoaXMubm9kZS5wYXRoLFxuICAgICAgdnBjQXJuOiB0aGlzLnZwYz8udnBjQXJuLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHMubWFwKHNnID0+IHNnLnNlY3VyaXR5R3JvdXBJZCksXG4gICAgICByb2xlQXJuOiB0aGlzLnRhc2sudGFza1JvbGUucm9sZUFybixcbiAgICAgIGxvZ0dyb3VwOiB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICAgIGltYWdlOiB7XG4gICAgICAgIGltYWdlUmVwb3NpdG9yeTogdGhpcy5pbWFnZS5pbWFnZVJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgICAgaW1hZ2VUYWc6IHRoaXMuaW1hZ2UuaW1hZ2VUYWcsXG4gICAgICAgIGltYWdlQnVpbGRlckxvZ0dyb3VwOiB0aGlzLmltYWdlLmxvZ0dyb3VwPy5sb2dHcm91cE5hbWUsXG4gICAgICB9LFxuICAgIH07XG4gIH1cbn1cbiJdfQ==