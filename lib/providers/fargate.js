"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FargateRunner = exports.FargateRunnerProvider = void 0;
exports.ecsRunCommand = ecsRunCommand;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const path = require("path");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const aws_stepfunctions_1 = require("aws-cdk-lib/aws-stepfunctions");
const common_1 = require("./common");
const image_builders_1 = require("../image-builders");
const utils_1 = require("../utils");
/**
 * Our special launch target that can use spot instances and set EnableExecuteCommand.
 */
class EcsFargateLaunchTarget {
    constructor(props) {
        this.props = props;
    }
    /**
     * Called when the Fargate launch type configured on RunTask
     */
    bind(_task, launchTargetOptions) {
        if (!launchTargetOptions.taskDefinition.isFargateCompatible) {
            throw new Error('Supplied TaskDefinition is not compatible with Fargate');
        }
        return {
            parameters: {
                PropagateTags: aws_cdk_lib_1.aws_ecs.PropagatedTagSource.TASK_DEFINITION,
                CapacityProviderStrategy: [
                    {
                        CapacityProvider: this.props.spot ? 'FARGATE_SPOT' : 'FARGATE',
                    },
                ],
            },
        };
    }
}
/**
 * @internal
 */
function ecsRunCommand(os, dind) {
    if (os.isIn(common_1.Os._ALL_LINUX_VERSIONS)) {
        let dindCommand = '';
        if (dind) {
            dindCommand = 'nohup sudo dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 --storage-driver=overlay2 & ' +
                'timeout 15 sh -c "until docker info; do echo .; sleep 1; done"';
        }
        return [
            'sh', '-c',
            `${dindCommand}
        cd /home/runner &&
        if [ "$RUNNER_VERSION" = "latest" ]; then RUNNER_FLAGS=""; else RUNNER_FLAGS="--disableupdate"; fi &&
        ./config.sh --unattended --url "$REGISTRATION_URL" --token "$RUNNER_TOKEN" --ephemeral --work _work --labels "$RUNNER_LABEL,cdkghr:started:\`date +%s\`" $RUNNER_FLAGS --name "$RUNNER_NAME" $RUNNER_GROUP1 $RUNNER_GROUP2 $DEFAULT_LABELS &&
        ./run.sh &&
        STATUS=$(grep -Phors "finish job request for job [0-9a-f-]+ with result: .*" _diag | tail -n1 | awk '{print $NF}') &&
        [ -n "$STATUS" ] && echo CDKGHA JOB DONE "$RUNNER_LABEL" "$STATUS"`,
        ];
    }
    else if (os.is(common_1.Os.WINDOWS)) {
        return [
            'powershell', '-Command',
            `cd \\actions ;
        if ($Env:RUNNER_VERSION -eq "latest") { $RunnerFlags = "" } else { $RunnerFlags = "--disableupdate" } ;
        ./config.cmd --unattended --url "\${Env:REGISTRATION_URL}" --token "\${Env:RUNNER_TOKEN}" --ephemeral --work _work --labels "\${Env:RUNNER_LABEL},cdkghr:started:\$(Get-Date -UFormat +%s)" $RunnerFlags --name "\${Env:RUNNER_NAME}" \${Env:RUNNER_GROUP1} \${Env:RUNNER_GROUP2} \${Env:DEFAULT_LABELS} ;
        ./run.cmd ;
        $STATUS = Select-String -Path './_diag/*.log' -Pattern 'finish job request for job [0-9a-f\\-]+ with result: (.*)' | %{$_.Matches.Groups[1].Value} | Select-Object -Last 1 ;
        if ($STATUS) { echo "CDKGHA JOB DONE $\{Env:RUNNER_LABEL\} $STATUS" }`,
        ];
    }
    else {
        throw new Error(`Fargate runner doesn't support ${os.name}`);
    }
}
/**
 * GitHub Actions runner provider using Fargate to execute jobs.
 *
 * Creates a task definition with a single container that gets started for each job.
 *
 * This construct is not meant to be used by itself. It should be passed in the providers property for GitHubRunners.
 */
class FargateRunnerProvider extends common_1.BaseProvider {
    /**
     * Create new image builder that builds Fargate specific runner images.
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
                image_builders_1.RunnerImageComponent.githubRunner(props?.runnerVersion ?? common_1.RunnerVersion.latest()),
            ],
            ...props,
        });
    }
    constructor(scope, id, props) {
        super(scope, id, props);
        this.retryableErrors = [
            'Ecs.EcsException',
            'Ecs.LimitExceededException',
            'Ecs.UpdateInProgressException',
        ];
        this.labels = this.labelsFromProperties('fargate', props?.label, props?.labels);
        this.group = props?.group;
        this.defaultLabels = props?.defaultLabels ?? true;
        this.vpc = props?.vpc ?? aws_cdk_lib_1.aws_ec2.Vpc.fromLookup(this, 'default vpc', { isDefault: true });
        this.subnetSelection = props?.subnetSelection;
        this.securityGroups = props?.securityGroup ? [props.securityGroup] : (props?.securityGroups ?? [new aws_cdk_lib_1.aws_ec2.SecurityGroup(this, 'security group', { vpc: this.vpc })]);
        this.connections = new aws_cdk_lib_1.aws_ec2.Connections({ securityGroups: this.securityGroups });
        this.assignPublicIp = props?.assignPublicIp ?? true;
        this.cluster = props?.cluster ? props.cluster : new aws_cdk_lib_1.aws_ecs.Cluster(this, 'cluster', {
            vpc: this.vpc,
            enableFargateCapacityProviders: true,
        });
        this.spot = props?.spot ?? false;
        const imageBuilder = props?.imageBuilder ?? FargateRunnerProvider.imageBuilder(this, 'Image Builder');
        const image = this.image = imageBuilder.bindDockerImage();
        let arch;
        if (image.architecture.is(common_1.Architecture.ARM64)) {
            arch = aws_cdk_lib_1.aws_ecs.CpuArchitecture.ARM64;
        }
        else if (image.architecture.is(common_1.Architecture.X86_64)) {
            arch = aws_cdk_lib_1.aws_ecs.CpuArchitecture.X86_64;
        }
        else {
            throw new Error(`${image.architecture.name} is not supported on Fargate`);
        }
        let os;
        if (image.os.isIn(common_1.Os._ALL_LINUX_VERSIONS)) {
            os = aws_cdk_lib_1.aws_ecs.OperatingSystemFamily.LINUX;
        }
        else if (image.os.is(common_1.Os.WINDOWS)) {
            os = aws_cdk_lib_1.aws_ecs.OperatingSystemFamily.WINDOWS_SERVER_2019_CORE;
            if (props?.ephemeralStorageGiB) {
                throw new Error('Ephemeral storage is not supported on Fargate Windows');
            }
        }
        else {
            throw new Error(`${image.os.name} is not supported on Fargate`);
        }
        this.logGroup = new aws_cdk_lib_1.aws_logs.LogGroup(this, 'logs', {
            retention: props?.logRetention ?? aws_logs_1.RetentionDays.ONE_MONTH,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        this.task = new aws_cdk_lib_1.aws_ecs.FargateTaskDefinition(this, 'task', {
            cpu: props?.cpu ?? 1024,
            memoryLimitMiB: props?.memoryLimitMiB ?? 2048,
            ephemeralStorageGiB: props?.ephemeralStorageGiB ?? (!image.os.is(common_1.Os.WINDOWS) ? 25 : undefined),
            runtimePlatform: {
                operatingSystemFamily: os,
                cpuArchitecture: arch,
            },
        });
        this.container = this.task.addContainer('runner', {
            image: aws_cdk_lib_1.aws_ecs.AssetImage.fromEcrRepository(image.imageRepository, image.imageTag),
            logging: aws_cdk_lib_1.aws_ecs.AwsLogDriver.awsLogs({
                logGroup: this.logGroup,
                streamPrefix: 'runner',
            }),
            command: ecsRunCommand(this.image.os, false),
            user: image.os.is(common_1.Os.WINDOWS) ? undefined : 'runner',
        });
        this.grantPrincipal = this.task.taskRole;
        // allow SSM Session Manager
        this.task.taskRole.addToPrincipalPolicy(utils_1.MINIMAL_SSM_SESSION_MANAGER_POLICY_STATEMENT);
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
            launchTarget: new EcsFargateLaunchTarget({
                spot: this.spot,
            }),
            enableExecuteCommand: this.image.os.isIn(common_1.Os._ALL_LINUX_VERSIONS),
            subnets: this.subnetSelection,
            assignPublicIp: this.assignPublicIp,
            securityGroups: this.securityGroups,
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
exports.FargateRunnerProvider = FargateRunnerProvider;
_a = JSII_RTTI_SYMBOL_1;
FargateRunnerProvider[_a] = { fqn: "@cloudsnorkel/cdk-github-runners.FargateRunnerProvider", version: "0.0.0" };
/**
 * Path to Dockerfile for Linux x64 with all the requirement for Fargate runner. Use this Dockerfile unless you need to customize it further than allowed by hooks.
 *
 * Available build arguments that can be set in the image builder:
 * * `BASE_IMAGE` sets the `FROM` line. This should be an Ubuntu compatible image.
 * * `EXTRA_PACKAGES` can be used to install additional packages.
 *
 * @deprecated Use `imageBuilder()` instead.
 */
FargateRunnerProvider.LINUX_X64_DOCKERFILE_PATH = path.join(__dirname, '..', '..', 'assets', 'docker-images', 'fargate', 'linux-x64');
/**
 * Path to Dockerfile for Linux ARM64 with all the requirement for Fargate runner. Use this Dockerfile unless you need to customize it further than allowed by hooks.
 *
 * Available build arguments that can be set in the image builder:
 * * `BASE_IMAGE` sets the `FROM` line. This should be an Ubuntu compatible image.
 * * `EXTRA_PACKAGES` can be used to install additional packages.
 *
 * @deprecated Use `imageBuilder()` instead.
 */
FargateRunnerProvider.LINUX_ARM64_DOCKERFILE_PATH = path.join(__dirname, '..', '..', 'assets', 'docker-images', 'fargate', 'linux-arm64');
/**
 * @deprecated use {@link FargateRunnerProvider}
 */
class FargateRunner extends FargateRunnerProvider {
}
exports.FargateRunner = FargateRunner;
_b = JSII_RTTI_SYMBOL_1;
FargateRunner[_b] = { fqn: "@cloudsnorkel/cdk-github-runners.FargateRunner", version: "0.0.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmFyZ2F0ZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9wcm92aWRlcnMvZmFyZ2F0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBd05BLHNDQStCQzs7QUF2UEQsNkJBQTZCO0FBQzdCLDZDQVFxQjtBQUNyQixtREFBcUQ7QUFDckQscUVBQW1FO0FBRW5FLHFDQVdrQjtBQUNsQixzREFBMkg7QUFDM0gsb0NBQXdFO0FBOEp4RTs7R0FFRztBQUNILE1BQU0sc0JBQXNCO0lBQzFCLFlBQXFCLEtBQWtDO1FBQWxDLFVBQUssR0FBTCxLQUFLLENBQTZCO0lBQ3ZELENBQUM7SUFFRDs7T0FFRztJQUNJLElBQUksQ0FBQyxLQUFxQyxFQUMvQyxtQkFBZ0U7UUFDaEUsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGNBQWMsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDO1lBQzVELE1BQU0sSUFBSSxLQUFLLENBQUMsd0RBQXdELENBQUMsQ0FBQztRQUM1RSxDQUFDO1FBRUQsT0FBTztZQUNMLFVBQVUsRUFBRTtnQkFDVixhQUFhLEVBQUUscUJBQUcsQ0FBQyxtQkFBbUIsQ0FBQyxlQUFlO2dCQUN0RCx3QkFBd0IsRUFBRTtvQkFDeEI7d0JBQ0UsZ0JBQWdCLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsU0FBUztxQkFDL0Q7aUJBQ0Y7YUFDRjtTQUNGLENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFFRDs7R0FFRztBQUNILFNBQWdCLGFBQWEsQ0FBQyxFQUFNLEVBQUUsSUFBYTtJQUNqRCxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsV0FBRSxDQUFDLG1CQUFtQixDQUFDLEVBQUUsQ0FBQztRQUNwQyxJQUFJLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFDckIsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNULFdBQVcsR0FBRyxnSEFBZ0g7Z0JBQzVILGdFQUFnRSxDQUFDO1FBQ3JF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QUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsV0FBVyxDQUFDLEFBQXRGLENBQXVGO0FBRXZJOzs7Ozs7OztHQVFHO0FBQ29CLGlEQUEyQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsYUFBYSxDQUFDLEFBQXhGLENBQXlGO0FBNFM3STs7R0FFRztBQUNILE1BQWEsYUFBYyxTQUFRLHFCQUFxQjs7QUFBeEQsc0NBQ0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHtcbiAgYXdzX2VjMiBhcyBlYzIsXG4gIGF3c19lY3MgYXMgZWNzLFxuICBhd3NfaWFtIGFzIGlhbSxcbiAgYXdzX2xvZ3MgYXMgbG9ncyxcbiAgYXdzX3N0ZXBmdW5jdGlvbnMgYXMgc3RlcGZ1bmN0aW9ucyxcbiAgYXdzX3N0ZXBmdW5jdGlvbnNfdGFza3MgYXMgc3RlcGZ1bmN0aW9uc190YXNrcyxcbiAgUmVtb3ZhbFBvbGljeSxcbn0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgUmV0ZW50aW9uRGF5cyB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCB7IEludGVncmF0aW9uUGF0dGVybiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zdGVwZnVuY3Rpb25zJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHtcbiAgQXJjaGl0ZWN0dXJlLFxuICBCYXNlUHJvdmlkZXIsXG4gIElSdW5uZXJQcm92aWRlcixcbiAgSVJ1bm5lclByb3ZpZGVyU3RhdHVzLFxuICBPcyxcbiAgUnVubmVySW1hZ2UsXG4gIFJ1bm5lclByb3ZpZGVyUHJvcHMsXG4gIFJ1bm5lclJ1bnRpbWVQYXJhbWV0ZXJzLFxuICBSdW5uZXJWZXJzaW9uLFxuICBnZW5lcmF0ZVN0YXRlTmFtZSxcbn0gZnJvbSAnLi9jb21tb24nO1xuaW1wb3J0IHsgSVJ1bm5lckltYWdlQnVpbGRlciwgUnVubmVySW1hZ2VCdWlsZGVyLCBSdW5uZXJJbWFnZUJ1aWxkZXJQcm9wcywgUnVubmVySW1hZ2VDb21wb25lbnQgfSBmcm9tICcuLi9pbWFnZS1idWlsZGVycyc7XG5pbXBvcnQgeyBNSU5JTUFMX1NTTV9TRVNTSU9OX01BTkFHRVJfUE9MSUNZX1NUQVRFTUVOVCB9IGZyb20gJy4uL3V0aWxzJztcblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBGYXJnYXRlUnVubmVyUHJvdmlkZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyUHJvcHMgZXh0ZW5kcyBSdW5uZXJQcm92aWRlclByb3BzIHtcbiAgLyoqXG4gICAqIFJ1bm5lciBpbWFnZSBidWlsZGVyIHVzZWQgdG8gYnVpbGQgRG9ja2VyIGltYWdlcyBjb250YWluaW5nIEdpdEh1YiBSdW5uZXIgYW5kIGFsbCByZXF1aXJlbWVudHMuXG4gICAqXG4gICAqIFRoZSBpbWFnZSBidWlsZGVyIGRldGVybWluZXMgdGhlIE9TIGFuZCBhcmNoaXRlY3R1cmUgb2YgdGhlIHJ1bm5lci5cbiAgICpcbiAgICogQGRlZmF1bHQgRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyLmltYWdlQnVpbGRlcigpXG4gICAqL1xuICByZWFkb25seSBpbWFnZUJ1aWxkZXI/OiBJUnVubmVySW1hZ2VCdWlsZGVyO1xuXG4gIC8qKlxuICAgKiBHaXRIdWIgQWN0aW9ucyBsYWJlbCB1c2VkIGZvciB0aGlzIHByb3ZpZGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgdXNlIHtAbGluayBsYWJlbHN9IGluc3RlYWRcbiAgICovXG4gIHJlYWRvbmx5IGxhYmVsPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBHaXRIdWIgQWN0aW9ucyBsYWJlbHMgdXNlZCBmb3IgdGhpcyBwcm92aWRlci5cbiAgICpcbiAgICogVGhlc2UgbGFiZWxzIGFyZSB1c2VkIHRvIGlkZW50aWZ5IHdoaWNoIHByb3ZpZGVyIHNob3VsZCBzcGF3biBhIG5ldyBvbi1kZW1hbmQgcnVubmVyLiBFdmVyeSBqb2Igc2VuZHMgYSB3ZWJob29rIHdpdGggdGhlIGxhYmVscyBpdCdzIGxvb2tpbmcgZm9yXG4gICAqIGJhc2VkIG9uIHJ1bnMtb24uIFdlIG1hdGNoIHRoZSBsYWJlbHMgZnJvbSB0aGUgd2ViaG9vayB3aXRoIHRoZSBsYWJlbHMgc3BlY2lmaWVkIGhlcmUuIElmIGFsbCB0aGUgbGFiZWxzIHNwZWNpZmllZCBoZXJlIGFyZSBwcmVzZW50IGluIHRoZVxuICAgKiBqb2IncyBsYWJlbHMsIHRoaXMgcHJvdmlkZXIgd2lsbCBiZSBjaG9zZW4gYW5kIHNwYXduIGEgbmV3IHJ1bm5lci5cbiAgICpcbiAgICogQGRlZmF1bHQgWydmYXJnYXRlJ11cbiAgICovXG4gIHJlYWRvbmx5IGxhYmVscz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBHaXRIdWIgQWN0aW9ucyBydW5uZXIgZ3JvdXAgbmFtZS5cbiAgICpcbiAgICogSWYgc3BlY2lmaWVkLCB0aGUgcnVubmVyIHdpbGwgYmUgcmVnaXN0ZXJlZCB3aXRoIHRoaXMgZ3JvdXAgbmFtZS4gU2V0dGluZyBhIHJ1bm5lciBncm91cCBjYW4gaGVscCBtYW5hZ2luZyBhY2Nlc3MgdG8gc2VsZi1ob3N0ZWQgcnVubmVycy4gSXRcbiAgICogcmVxdWlyZXMgYSBwYWlkIEdpdEh1YiBhY2NvdW50LlxuICAgKlxuICAgKiBUaGUgZ3JvdXAgbXVzdCBleGlzdCBvciB0aGUgcnVubmVyIHdpbGwgbm90IHN0YXJ0LlxuICAgKlxuICAgKiBVc2VycyB3aWxsIHN0aWxsIGJlIGFibGUgdG8gdHJpZ2dlciB0aGlzIHJ1bm5lciB3aXRoIHRoZSBjb3JyZWN0IGxhYmVscy4gQnV0IHRoZSBydW5uZXIgd2lsbCBvbmx5IGJlIGFibGUgdG8gcnVuIGpvYnMgZnJvbSByZXBvcyBhbGxvd2VkIHRvIHVzZSB0aGUgZ3JvdXAuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZ3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFZQQyB0byBsYXVuY2ggdGhlIHJ1bm5lcnMgaW4uXG4gICAqXG4gICAqIEBkZWZhdWx0IGRlZmF1bHQgYWNjb3VudCBWUENcbiAgICovXG4gIHJlYWRvbmx5IHZwYz86IGVjMi5JVnBjO1xuXG4gIC8qKlxuICAgKiBTdWJuZXRzIHRvIHJ1biB0aGUgcnVubmVycyBpbi5cbiAgICpcbiAgICogQGRlZmF1bHQgRmFyZ2F0ZSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzdWJuZXRTZWxlY3Rpb24/OiBlYzIuU3VibmV0U2VsZWN0aW9uO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cCB0byBhc3NpZ24gdG8gdGhlIHRhc2suXG4gICAqXG4gICAqIEBkZWZhdWx0IGEgbmV3IHNlY3VyaXR5IGdyb3VwXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIHVzZSB7QGxpbmsgc2VjdXJpdHlHcm91cHN9XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eUdyb3VwPzogZWMyLklTZWN1cml0eUdyb3VwO1xuXG4gIC8qKlxuICAgKiBTZWN1cml0eSBncm91cHMgdG8gYXNzaWduIHRvIHRoZSB0YXNrLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhIG5ldyBzZWN1cml0eSBncm91cFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcblxuICAvKipcbiAgICogRXhpc3RpbmcgRmFyZ2F0ZSBjbHVzdGVyIHRvIHVzZS5cbiAgICpcbiAgICogQGRlZmF1bHQgYSBuZXcgY2x1c3RlclxuICAgKi9cbiAgcmVhZG9ubHkgY2x1c3Rlcj86IGVjcy5DbHVzdGVyO1xuXG4gIC8qKlxuICAgKiBBc3NpZ24gcHVibGljIElQIHRvIHRoZSBydW5uZXIgdGFzay5cbiAgICpcbiAgICogTWFrZSBzdXJlIHRoZSB0YXNrIHdpbGwgaGF2ZSBhY2Nlc3MgdG8gR2l0SHViLiBBIHB1YmxpYyBJUCBtaWdodCBiZSByZXF1aXJlZCB1bmxlc3MgeW91IGhhdmUgTkFUIGdhdGV3YXkuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGFzc2lnblB1YmxpY0lwPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVGhlIG51bWJlciBvZiBjcHUgdW5pdHMgdXNlZCBieSB0aGUgdGFzay4gRm9yIHRhc2tzIHVzaW5nIHRoZSBGYXJnYXRlIGxhdW5jaCB0eXBlLFxuICAgKiB0aGlzIGZpZWxkIGlzIHJlcXVpcmVkIGFuZCB5b3UgbXVzdCB1c2Ugb25lIG9mIHRoZSBmb2xsb3dpbmcgdmFsdWVzLFxuICAgKiB3aGljaCBkZXRlcm1pbmVzIHlvdXIgcmFuZ2Ugb2YgdmFsaWQgdmFsdWVzIGZvciB0aGUgbWVtb3J5IHBhcmFtZXRlcjpcbiAgICpcbiAgICogMjU2ICguMjUgdkNQVSkgLSBBdmFpbGFibGUgbWVtb3J5IHZhbHVlczogNTEyICgwLjUgR0IpLCAxMDI0ICgxIEdCKSwgMjA0OCAoMiBHQilcbiAgICpcbiAgICogNTEyICguNSB2Q1BVKSAtIEF2YWlsYWJsZSBtZW1vcnkgdmFsdWVzOiAxMDI0ICgxIEdCKSwgMjA0OCAoMiBHQiksIDMwNzIgKDMgR0IpLCA0MDk2ICg0IEdCKVxuICAgKlxuICAgKiAxMDI0ICgxIHZDUFUpIC0gQXZhaWxhYmxlIG1lbW9yeSB2YWx1ZXM6IDIwNDggKDIgR0IpLCAzMDcyICgzIEdCKSwgNDA5NiAoNCBHQiksIDUxMjAgKDUgR0IpLCA2MTQ0ICg2IEdCKSwgNzE2OCAoNyBHQiksIDgxOTIgKDggR0IpXG4gICAqXG4gICAqIDIwNDggKDIgdkNQVSkgLSBBdmFpbGFibGUgbWVtb3J5IHZhbHVlczogQmV0d2VlbiA0MDk2ICg0IEdCKSBhbmQgMTYzODQgKDE2IEdCKSBpbiBpbmNyZW1lbnRzIG9mIDEwMjQgKDEgR0IpXG4gICAqXG4gICAqIDQwOTYgKDQgdkNQVSkgLSBBdmFpbGFibGUgbWVtb3J5IHZhbHVlczogQmV0d2VlbiA4MTkyICg4IEdCKSBhbmQgMzA3MjAgKDMwIEdCKSBpbiBpbmNyZW1lbnRzIG9mIDEwMjQgKDEgR0IpXG4gICAqXG4gICAqIEBkZWZhdWx0IDEwMjRcbiAgICovXG4gIHJlYWRvbmx5IGNwdT86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhlIGFtb3VudCAoaW4gTWlCKSBvZiBtZW1vcnkgdXNlZCBieSB0aGUgdGFzay4gRm9yIHRhc2tzIHVzaW5nIHRoZSBGYXJnYXRlIGxhdW5jaCB0eXBlLFxuICAgKiB0aGlzIGZpZWxkIGlzIHJlcXVpcmVkIGFuZCB5b3UgbXVzdCB1c2Ugb25lIG9mIHRoZSBmb2xsb3dpbmcgdmFsdWVzLCB3aGljaCBkZXRlcm1pbmVzIHlvdXIgcmFuZ2Ugb2YgdmFsaWQgdmFsdWVzIGZvciB0aGUgY3B1IHBhcmFtZXRlcjpcbiAgICpcbiAgICogNTEyICgwLjUgR0IpLCAxMDI0ICgxIEdCKSwgMjA0OCAoMiBHQikgLSBBdmFpbGFibGUgY3B1IHZhbHVlczogMjU2ICguMjUgdkNQVSlcbiAgICpcbiAgICogMTAyNCAoMSBHQiksIDIwNDggKDIgR0IpLCAzMDcyICgzIEdCKSwgNDA5NiAoNCBHQikgLSBBdmFpbGFibGUgY3B1IHZhbHVlczogNTEyICguNSB2Q1BVKVxuICAgKlxuICAgKiAyMDQ4ICgyIEdCKSwgMzA3MiAoMyBHQiksIDQwOTYgKDQgR0IpLCA1MTIwICg1IEdCKSwgNjE0NCAoNiBHQiksIDcxNjggKDcgR0IpLCA4MTkyICg4IEdCKSAtIEF2YWlsYWJsZSBjcHUgdmFsdWVzOiAxMDI0ICgxIHZDUFUpXG4gICAqXG4gICAqIEJldHdlZW4gNDA5NiAoNCBHQikgYW5kIDE2Mzg0ICgxNiBHQikgaW4gaW5jcmVtZW50cyBvZiAxMDI0ICgxIEdCKSAtIEF2YWlsYWJsZSBjcHUgdmFsdWVzOiAyMDQ4ICgyIHZDUFUpXG4gICAqXG4gICAqIEJldHdlZW4gODE5MiAoOCBHQikgYW5kIDMwNzIwICgzMCBHQikgaW4gaW5jcmVtZW50cyBvZiAxMDI0ICgxIEdCKSAtIEF2YWlsYWJsZSBjcHUgdmFsdWVzOiA0MDk2ICg0IHZDUFUpXG4gICAqXG4gICAqIEBkZWZhdWx0IDIwNDhcbiAgICovXG4gIHJlYWRvbmx5IG1lbW9yeUxpbWl0TWlCPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaGUgYW1vdW50IChpbiBHaUIpIG9mIGVwaGVtZXJhbCBzdG9yYWdlIHRvIGJlIGFsbG9jYXRlZCB0byB0aGUgdGFzay4gVGhlIG1heGltdW0gc3VwcG9ydGVkIHZhbHVlIGlzIDIwMCBHaUIuXG4gICAqXG4gICAqIE5PVEU6IFRoaXMgcGFyYW1ldGVyIGlzIG9ubHkgc3VwcG9ydGVkIGZvciB0YXNrcyBob3N0ZWQgb24gQVdTIEZhcmdhdGUgdXNpbmcgcGxhdGZvcm0gdmVyc2lvbiAxLjQuMCBvciBsYXRlci5cbiAgICpcbiAgICogQGRlZmF1bHQgMjBcbiAgICovXG4gIHJlYWRvbmx5IGVwaGVtZXJhbFN0b3JhZ2VHaUI/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFVzZSBGYXJnYXRlIHNwb3QgY2FwYWNpdHkgcHJvdmlkZXIgdG8gc2F2ZSBtb25leS5cbiAgICpcbiAgICogKiBSdW5uZXJzIG1heSBmYWlsIHRvIHN0YXJ0IGR1ZSB0byBtaXNzaW5nIGNhcGFjaXR5LlxuICAgKiAqIFJ1bm5lcnMgbWlnaHQgYmUgc3RvcHBlZCBwcmVtYXR1cmVseSB3aXRoIHNwb3QgcHJpY2luZy5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHNwb3Q/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEVjc0ZhcmdhdGVMYXVuY2hUYXJnZXQuXG4gKi9cbmludGVyZmFjZSBFY3NGYXJnYXRlTGF1bmNoVGFyZ2V0UHJvcHMge1xuICByZWFkb25seSBzcG90OiBib29sZWFuO1xufVxuXG4vKipcbiAqIE91ciBzcGVjaWFsIGxhdW5jaCB0YXJnZXQgdGhhdCBjYW4gdXNlIHNwb3QgaW5zdGFuY2VzIGFuZCBzZXQgRW5hYmxlRXhlY3V0ZUNvbW1hbmQuXG4gKi9cbmNsYXNzIEVjc0ZhcmdhdGVMYXVuY2hUYXJnZXQgaW1wbGVtZW50cyBzdGVwZnVuY3Rpb25zX3Rhc2tzLklFY3NMYXVuY2hUYXJnZXQge1xuICBjb25zdHJ1Y3RvcihyZWFkb25seSBwcm9wczogRWNzRmFyZ2F0ZUxhdW5jaFRhcmdldFByb3BzKSB7XG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIHdoZW4gdGhlIEZhcmdhdGUgbGF1bmNoIHR5cGUgY29uZmlndXJlZCBvbiBSdW5UYXNrXG4gICAqL1xuICBwdWJsaWMgYmluZChfdGFzazogc3RlcGZ1bmN0aW9uc190YXNrcy5FY3NSdW5UYXNrLFxuICAgIGxhdW5jaFRhcmdldE9wdGlvbnM6IHN0ZXBmdW5jdGlvbnNfdGFza3MuTGF1bmNoVGFyZ2V0QmluZE9wdGlvbnMpOiBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc0xhdW5jaFRhcmdldENvbmZpZyB7XG4gICAgaWYgKCFsYXVuY2hUYXJnZXRPcHRpb25zLnRhc2tEZWZpbml0aW9uLmlzRmFyZ2F0ZUNvbXBhdGlibGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignU3VwcGxpZWQgVGFza0RlZmluaXRpb24gaXMgbm90IGNvbXBhdGlibGUgd2l0aCBGYXJnYXRlJyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgUHJvcGFnYXRlVGFnczogZWNzLlByb3BhZ2F0ZWRUYWdTb3VyY2UuVEFTS19ERUZJTklUSU9OLFxuICAgICAgICBDYXBhY2l0eVByb3ZpZGVyU3RyYXRlZ3k6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBDYXBhY2l0eVByb3ZpZGVyOiB0aGlzLnByb3BzLnNwb3QgPyAnRkFSR0FURV9TUE9UJyA6ICdGQVJHQVRFJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogQGludGVybmFsXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlY3NSdW5Db21tYW5kKG9zOiBPcywgZGluZDogYm9vbGVhbik6IHN0cmluZ1tdIHtcbiAgaWYgKG9zLmlzSW4oT3MuX0FMTF9MSU5VWF9WRVJTSU9OUykpIHtcbiAgICBsZXQgZGluZENvbW1hbmQgPSAnJztcbiAgICBpZiAoZGluZCkge1xuICAgICAgZGluZENvbW1hbmQgPSAnbm9odXAgc3VkbyBkb2NrZXJkIC0taG9zdD11bml4Oi8vL3Zhci9ydW4vZG9ja2VyLnNvY2sgLS1ob3N0PXRjcDovLzEyNy4wLjAuMToyMzc1IC0tc3RvcmFnZS1kcml2ZXI9b3ZlcmxheTIgJiAnICtcbiAgICAgICAgJ3RpbWVvdXQgMTUgc2ggLWMgXCJ1bnRpbCBkb2NrZXIgaW5mbzsgZG8gZWNobyAuOyBzbGVlcCAxOyBkb25lXCInO1xuICAgIH1cblxuICAgIHJldHVybiBbXG4gICAgICAnc2gnLCAnLWMnLFxuICAgICAgYCR7ZGluZENvbW1hbmR9XG4gICAgICAgIGNkIC9ob21lL3J1bm5lciAmJlxuICAgICAgICBpZiBbIFwiJFJVTk5FUl9WRVJTSU9OXCIgPSBcImxhdGVzdFwiIF07IHRoZW4gUlVOTkVSX0ZMQUdTPVwiXCI7IGVsc2UgUlVOTkVSX0ZMQUdTPVwiLS1kaXNhYmxldXBkYXRlXCI7IGZpICYmXG4gICAgICAgIC4vY29uZmlnLnNoIC0tdW5hdHRlbmRlZCAtLXVybCBcIiRSRUdJU1RSQVRJT05fVVJMXCIgLS10b2tlbiBcIiRSVU5ORVJfVE9LRU5cIiAtLWVwaGVtZXJhbCAtLXdvcmsgX3dvcmsgLS1sYWJlbHMgXCIkUlVOTkVSX0xBQkVMLGNka2docjpzdGFydGVkOlxcYGRhdGUgKyVzXFxgXCIgJFJVTk5FUl9GTEFHUyAtLW5hbWUgXCIkUlVOTkVSX05BTUVcIiAkUlVOTkVSX0dST1VQMSAkUlVOTkVSX0dST1VQMiAkREVGQVVMVF9MQUJFTFMgJiZcbiAgICAgICAgLi9ydW4uc2ggJiZcbiAgICAgICAgU1RBVFVTPSQoZ3JlcCAtUGhvcnMgXCJmaW5pc2ggam9iIHJlcXVlc3QgZm9yIGpvYiBbMC05YS1mLV0rIHdpdGggcmVzdWx0OiAuKlwiIF9kaWFnIHwgdGFpbCAtbjEgfCBhd2sgJ3twcmludCAkTkZ9JykgJiZcbiAgICAgICAgWyAtbiBcIiRTVEFUVVNcIiBdICYmIGVjaG8gQ0RLR0hBIEpPQiBET05FIFwiJFJVTk5FUl9MQUJFTFwiIFwiJFNUQVRVU1wiYCxcbiAgICBdO1xuICB9IGVsc2UgaWYgKG9zLmlzKE9zLldJTkRPV1MpKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgICdwb3dlcnNoZWxsJywgJy1Db21tYW5kJyxcbiAgICAgIGBjZCBcXFxcYWN0aW9ucyA7XG4gICAgICAgIGlmICgkRW52OlJVTk5FUl9WRVJTSU9OIC1lcSBcImxhdGVzdFwiKSB7ICRSdW5uZXJGbGFncyA9IFwiXCIgfSBlbHNlIHsgJFJ1bm5lckZsYWdzID0gXCItLWRpc2FibGV1cGRhdGVcIiB9IDtcbiAgICAgICAgLi9jb25maWcuY21kIC0tdW5hdHRlbmRlZCAtLXVybCBcIlxcJHtFbnY6UkVHSVNUUkFUSU9OX1VSTH1cIiAtLXRva2VuIFwiXFwke0VudjpSVU5ORVJfVE9LRU59XCIgLS1lcGhlbWVyYWwgLS13b3JrIF93b3JrIC0tbGFiZWxzIFwiXFwke0VudjpSVU5ORVJfTEFCRUx9LGNka2docjpzdGFydGVkOlxcJChHZXQtRGF0ZSAtVUZvcm1hdCArJXMpXCIgJFJ1bm5lckZsYWdzIC0tbmFtZSBcIlxcJHtFbnY6UlVOTkVSX05BTUV9XCIgXFwke0VudjpSVU5ORVJfR1JPVVAxfSBcXCR7RW52OlJVTk5FUl9HUk9VUDJ9IFxcJHtFbnY6REVGQVVMVF9MQUJFTFN9IDtcbiAgICAgICAgLi9ydW4uY21kIDtcbiAgICAgICAgJFNUQVRVUyA9IFNlbGVjdC1TdHJpbmcgLVBhdGggJy4vX2RpYWcvKi5sb2cnIC1QYXR0ZXJuICdmaW5pc2ggam9iIHJlcXVlc3QgZm9yIGpvYiBbMC05YS1mXFxcXC1dKyB3aXRoIHJlc3VsdDogKC4qKScgfCAleyRfLk1hdGNoZXMuR3JvdXBzWzFdLlZhbHVlfSB8IFNlbGVjdC1PYmplY3QgLUxhc3QgMSA7XG4gICAgICAgIGlmICgkU1RBVFVTKSB7IGVjaG8gXCJDREtHSEEgSk9CIERPTkUgJFxce0VudjpSVU5ORVJfTEFCRUxcXH0gJFNUQVRVU1wiIH1gLFxuICAgIF07XG4gIH0gZWxzZSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGYXJnYXRlIHJ1bm5lciBkb2Vzbid0IHN1cHBvcnQgJHtvcy5uYW1lfWApO1xuICB9XG59XG5cbi8qKlxuICogR2l0SHViIEFjdGlvbnMgcnVubmVyIHByb3ZpZGVyIHVzaW5nIEZhcmdhdGUgdG8gZXhlY3V0ZSBqb2JzLlxuICpcbiAqIENyZWF0ZXMgYSB0YXNrIGRlZmluaXRpb24gd2l0aCBhIHNpbmdsZSBjb250YWluZXIgdGhhdCBnZXRzIHN0YXJ0ZWQgZm9yIGVhY2ggam9iLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIG5vdCBtZWFudCB0byBiZSB1c2VkIGJ5IGl0c2VsZi4gSXQgc2hvdWxkIGJlIHBhc3NlZCBpbiB0aGUgcHJvdmlkZXJzIHByb3BlcnR5IGZvciBHaXRIdWJSdW5uZXJzLlxuICovXG5leHBvcnQgY2xhc3MgRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyIGV4dGVuZHMgQmFzZVByb3ZpZGVyIGltcGxlbWVudHMgSVJ1bm5lclByb3ZpZGVyIHtcbiAgLyoqXG4gICAqIFBhdGggdG8gRG9ja2VyZmlsZSBmb3IgTGludXggeDY0IHdpdGggYWxsIHRoZSByZXF1aXJlbWVudCBmb3IgRmFyZ2F0ZSBydW5uZXIuIFVzZSB0aGlzIERvY2tlcmZpbGUgdW5sZXNzIHlvdSBuZWVkIHRvIGN1c3RvbWl6ZSBpdCBmdXJ0aGVyIHRoYW4gYWxsb3dlZCBieSBob29rcy5cbiAgICpcbiAgICogQXZhaWxhYmxlIGJ1aWxkIGFyZ3VtZW50cyB0aGF0IGNhbiBiZSBzZXQgaW4gdGhlIGltYWdlIGJ1aWxkZXI6XG4gICAqICogYEJBU0VfSU1BR0VgIHNldHMgdGhlIGBGUk9NYCBsaW5lLiBUaGlzIHNob3VsZCBiZSBhbiBVYnVudHUgY29tcGF0aWJsZSBpbWFnZS5cbiAgICogKiBgRVhUUkFfUEFDS0FHRVNgIGNhbiBiZSB1c2VkIHRvIGluc3RhbGwgYWRkaXRpb25hbCBwYWNrYWdlcy5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBpbWFnZUJ1aWxkZXIoKWAgaW5zdGVhZC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgTElOVVhfWDY0X0RPQ0tFUkZJTEVfUEFUSCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdhc3NldHMnLCAnZG9ja2VyLWltYWdlcycsICdmYXJnYXRlJywgJ2xpbnV4LXg2NCcpO1xuXG4gIC8qKlxuICAgKiBQYXRoIHRvIERvY2tlcmZpbGUgZm9yIExpbnV4IEFSTTY0IHdpdGggYWxsIHRoZSByZXF1aXJlbWVudCBmb3IgRmFyZ2F0ZSBydW5uZXIuIFVzZSB0aGlzIERvY2tlcmZpbGUgdW5sZXNzIHlvdSBuZWVkIHRvIGN1c3RvbWl6ZSBpdCBmdXJ0aGVyIHRoYW4gYWxsb3dlZCBieSBob29rcy5cbiAgICpcbiAgICogQXZhaWxhYmxlIGJ1aWxkIGFyZ3VtZW50cyB0aGF0IGNhbiBiZSBzZXQgaW4gdGhlIGltYWdlIGJ1aWxkZXI6XG4gICAqICogYEJBU0VfSU1BR0VgIHNldHMgdGhlIGBGUk9NYCBsaW5lLiBUaGlzIHNob3VsZCBiZSBhbiBVYnVudHUgY29tcGF0aWJsZSBpbWFnZS5cbiAgICogKiBgRVhUUkFfUEFDS0FHRVNgIGNhbiBiZSB1c2VkIHRvIGluc3RhbGwgYWRkaXRpb25hbCBwYWNrYWdlcy5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVXNlIGBpbWFnZUJ1aWxkZXIoKWAgaW5zdGVhZC5cbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgcmVhZG9ubHkgTElOVVhfQVJNNjRfRE9DS0VSRklMRV9QQVRIID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJ2Fzc2V0cycsICdkb2NrZXItaW1hZ2VzJywgJ2ZhcmdhdGUnLCAnbGludXgtYXJtNjQnKTtcblxuICAvKipcbiAgICogQ3JlYXRlIG5ldyBpbWFnZSBidWlsZGVyIHRoYXQgYnVpbGRzIEZhcmdhdGUgc3BlY2lmaWMgcnVubmVyIGltYWdlcy5cbiAgICpcbiAgICogWW91IGNhbiBjdXN0b21pemUgdGhlIE9TLCBhcmNoaXRlY3R1cmUsIFZQQywgc3VibmV0LCBzZWN1cml0eSBncm91cHMsIGV0Yy4gYnkgcGFzc2luZyBpbiBwcm9wcy5cbiAgICpcbiAgICogWW91IGNhbiBhZGQgY29tcG9uZW50cyB0byB0aGUgaW1hZ2UgYnVpbGRlciBieSBjYWxsaW5nIGBpbWFnZUJ1aWxkZXIuYWRkQ29tcG9uZW50KClgLlxuICAgKlxuICAgKiBUaGUgZGVmYXVsdCBPUyBpcyBVYnVudHUgcnVubmluZyBvbiB4NjQgYXJjaGl0ZWN0dXJlLlxuICAgKlxuICAgKiBJbmNsdWRlZCBjb21wb25lbnRzOlxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQucmVxdWlyZWRQYWNrYWdlcygpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQucnVubmVyVXNlcigpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0KClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5naXRodWJDbGkoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmF3c0NsaSgpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0aHViUnVubmVyKClgXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGltYWdlQnVpbGRlcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IFJ1bm5lckltYWdlQnVpbGRlclByb3BzKSB7XG4gICAgcmV0dXJuIFJ1bm5lckltYWdlQnVpbGRlci5uZXcoc2NvcGUsIGlkLCB7XG4gICAgICBvczogT3MuTElOVVhfVUJVTlRVLFxuICAgICAgYXJjaGl0ZWN0dXJlOiBBcmNoaXRlY3R1cmUuWDg2XzY0LFxuICAgICAgY29tcG9uZW50czogW1xuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5yZXF1aXJlZFBhY2thZ2VzKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LnJ1bm5lclVzZXIoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0KCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YkNsaSgpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5hd3NDbGkoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0aHViUnVubmVyKHByb3BzPy5ydW5uZXJWZXJzaW9uID8/IFJ1bm5lclZlcnNpb24ubGF0ZXN0KCkpLFxuICAgICAgXSxcbiAgICAgIC4uLnByb3BzLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENsdXN0ZXIgaG9zdGluZyB0aGUgdGFzayBob3N0aW5nIHRoZSBydW5uZXIuXG4gICAqL1xuICByZWFkb25seSBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcblxuICAvKipcbiAgICogRmFyZ2F0ZSB0YXNrIGhvc3RpbmcgdGhlIHJ1bm5lci5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVGhpcyBmaWVsZCBpcyBpbnRlcm5hbCBhbmQgc2hvdWxkIG5vdCBiZSBhY2Nlc3NlZCBkaXJlY3RseS5cbiAgICovXG4gIHJlYWRvbmx5IHRhc2s6IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb247XG5cbiAgLyoqXG4gICAqIENvbnRhaW5lciBkZWZpbml0aW9uIGhvc3RpbmcgdGhlIHJ1bm5lci5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVGhpcyBmaWVsZCBpcyBpbnRlcm5hbCBhbmQgc2hvdWxkIG5vdCBiZSBhY2Nlc3NlZCBkaXJlY3RseS5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRhaW5lcjogZWNzLkNvbnRhaW5lckRlZmluaXRpb247XG5cbiAgLyoqXG4gICAqIExhYmVscyBhc3NvY2lhdGVkIHdpdGggdGhpcyBwcm92aWRlci5cbiAgICovXG4gIHJlYWRvbmx5IGxhYmVsczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFZQQyB1c2VkIGZvciBob3N0aW5nIHRoZSBydW5uZXIgdGFzay5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVGhpcyBmaWVsZCBpcyBpbnRlcm5hbCBhbmQgc2hvdWxkIG5vdCBiZSBhY2Nlc3NlZCBkaXJlY3RseS5cbiAgICovXG4gIHJlYWRvbmx5IHZwYz86IGVjMi5JVnBjO1xuXG4gIC8qKlxuICAgKiBTdWJuZXRzIHVzZWQgZm9yIGhvc3RpbmcgdGhlIHJ1bm5lciB0YXNrLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBUaGlzIGZpZWxkIGlzIGludGVybmFsIGFuZCBzaG91bGQgbm90IGJlIGFjY2Vzc2VkIGRpcmVjdGx5LlxuICAgKi9cbiAgcmVhZG9ubHkgc3VibmV0U2VsZWN0aW9uPzogZWMyLlN1Ym5ldFNlbGVjdGlvbjtcblxuICAvKipcbiAgICogV2hldGhlciBydW5uZXIgdGFzayB3aWxsIGhhdmUgYSBwdWJsaWMgSVAuXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIFRoaXMgZmllbGQgaXMgaW50ZXJuYWwgYW5kIHNob3VsZCBub3QgYmUgYWNjZXNzZWQgZGlyZWN0bHkuXG4gICAqL1xuICByZWFkb25seSBhc3NpZ25QdWJsaWNJcDogYm9vbGVhbjtcblxuICAvKipcbiAgICogR3JhbnQgcHJpbmNpcGFsIHVzZWQgdG8gYWRkIHBlcm1pc3Npb25zIHRvIHRoZSBydW5uZXIgcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGdyYW50UHJpbmNpcGFsOiBpYW0uSVByaW5jaXBhbDtcblxuICAvKipcbiAgICogVGhlIG5ldHdvcmsgY29ubmVjdGlvbnMgYXNzb2NpYXRlZCB3aXRoIHRoaXMgcmVzb3VyY2UuXG4gICAqL1xuICByZWFkb25seSBjb25uZWN0aW9uczogZWMyLkNvbm5lY3Rpb25zO1xuXG4gIC8qKlxuICAgKiBVc2Ugc3BvdCBwcmljaW5nIGZvciBGYXJnYXRlIHRhc2tzLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBUaGlzIGZpZWxkIGlzIGludGVybmFsIGFuZCBzaG91bGQgbm90IGJlIGFjY2Vzc2VkIGRpcmVjdGx5LlxuICAgKi9cbiAgcmVhZG9ubHkgc3BvdDogYm9vbGVhbjtcblxuICAvKipcbiAgICogRG9ja2VyIGltYWdlIGxvYWRlZCB3aXRoIEdpdEh1YiBBY3Rpb25zIFJ1bm5lciBhbmQgaXRzIHByZXJlcXVpc2l0ZXMuIFRoZSBpbWFnZSBpcyBidWlsdCBieSBhbiBpbWFnZSBidWlsZGVyIGFuZCBpcyBzcGVjaWZpYyB0byBGYXJnYXRlIHRhc2tzLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBUaGlzIGZpZWxkIGlzIGludGVybmFsIGFuZCBzaG91bGQgbm90IGJlIGFjY2Vzc2VkIGRpcmVjdGx5LlxuICAgKi9cbiAgcmVhZG9ubHkgaW1hZ2U6IFJ1bm5lckltYWdlO1xuXG4gIC8qKlxuICAgKiBMb2cgZ3JvdXAgd2hlcmUgcHJvdmlkZWQgcnVubmVycyB3aWxsIHNhdmUgdGhlaXIgbG9ncy5cbiAgICpcbiAgICogTm90ZSB0aGF0IHRoaXMgaXMgbm90IHRoZSBqb2IgbG9nLCBidXQgdGhlIHJ1bm5lciBpdHNlbGYuIEl0IHdpbGwgbm90IGNvbnRhaW4gb3V0cHV0IGZyb20gdGhlIEdpdEh1YiBBY3Rpb24gYnV0IG9ubHkgbWV0YWRhdGEgb24gaXRzIGV4ZWN1dGlvbi5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cDtcblxuICByZWFkb25seSByZXRyeWFibGVFcnJvcnMgPSBbXG4gICAgJ0Vjcy5FY3NFeGNlcHRpb24nLFxuICAgICdFY3MuTGltaXRFeGNlZWRlZEV4Y2VwdGlvbicsXG4gICAgJ0Vjcy5VcGRhdGVJblByb2dyZXNzRXhjZXB0aW9uJyxcbiAgXTtcblxuICBwcml2YXRlIHJlYWRvbmx5IGdyb3VwPzogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGRlZmF1bHRMYWJlbHM6IGJvb2xlYW47XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM6IGVjMi5JU2VjdXJpdHlHcm91cFtdO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIHRoaXMubGFiZWxzID0gdGhpcy5sYWJlbHNGcm9tUHJvcGVydGllcygnZmFyZ2F0ZScsIHByb3BzPy5sYWJlbCwgcHJvcHM/LmxhYmVscyk7XG4gICAgdGhpcy5ncm91cCA9IHByb3BzPy5ncm91cDtcbiAgICB0aGlzLmRlZmF1bHRMYWJlbHMgPSBwcm9wcz8uZGVmYXVsdExhYmVscyA/PyB0cnVlO1xuICAgIHRoaXMudnBjID0gcHJvcHM/LnZwYyA/PyBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgJ2RlZmF1bHQgdnBjJywgeyBpc0RlZmF1bHQ6IHRydWUgfSk7XG4gICAgdGhpcy5zdWJuZXRTZWxlY3Rpb24gPSBwcm9wcz8uc3VibmV0U2VsZWN0aW9uO1xuICAgIHRoaXMuc2VjdXJpdHlHcm91cHMgPSBwcm9wcz8uc2VjdXJpdHlHcm91cCA/IFtwcm9wcy5zZWN1cml0eUdyb3VwXSA6IChwcm9wcz8uc2VjdXJpdHlHcm91cHMgPz8gW25ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnc2VjdXJpdHkgZ3JvdXAnLCB7IHZwYzogdGhpcy52cGMgfSldKTtcbiAgICB0aGlzLmNvbm5lY3Rpb25zID0gbmV3IGVjMi5Db25uZWN0aW9ucyh7IHNlY3VyaXR5R3JvdXBzOiB0aGlzLnNlY3VyaXR5R3JvdXBzIH0pO1xuICAgIHRoaXMuYXNzaWduUHVibGljSXAgPSBwcm9wcz8uYXNzaWduUHVibGljSXAgPz8gdHJ1ZTtcbiAgICB0aGlzLmNsdXN0ZXIgPSBwcm9wcz8uY2x1c3RlciA/IHByb3BzLmNsdXN0ZXIgOiBuZXcgZWNzLkNsdXN0ZXIoXG4gICAgICB0aGlzLFxuICAgICAgJ2NsdXN0ZXInLFxuICAgICAge1xuICAgICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgICBlbmFibGVGYXJnYXRlQ2FwYWNpdHlQcm92aWRlcnM6IHRydWUsXG4gICAgICB9LFxuICAgICk7XG4gICAgdGhpcy5zcG90ID0gcHJvcHM/LnNwb3QgPz8gZmFsc2U7XG5cbiAgICBjb25zdCBpbWFnZUJ1aWxkZXIgPSBwcm9wcz8uaW1hZ2VCdWlsZGVyID8/IEZhcmdhdGVSdW5uZXJQcm92aWRlci5pbWFnZUJ1aWxkZXIodGhpcywgJ0ltYWdlIEJ1aWxkZXInKTtcbiAgICBjb25zdCBpbWFnZSA9IHRoaXMuaW1hZ2UgPSBpbWFnZUJ1aWxkZXIuYmluZERvY2tlckltYWdlKCk7XG5cbiAgICBsZXQgYXJjaDogZWNzLkNwdUFyY2hpdGVjdHVyZTtcbiAgICBpZiAoaW1hZ2UuYXJjaGl0ZWN0dXJlLmlzKEFyY2hpdGVjdHVyZS5BUk02NCkpIHtcbiAgICAgIGFyY2ggPSBlY3MuQ3B1QXJjaGl0ZWN0dXJlLkFSTTY0O1xuICAgIH0gZWxzZSBpZiAoaW1hZ2UuYXJjaGl0ZWN0dXJlLmlzKEFyY2hpdGVjdHVyZS5YODZfNjQpKSB7XG4gICAgICBhcmNoID0gZWNzLkNwdUFyY2hpdGVjdHVyZS5YODZfNjQ7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtpbWFnZS5hcmNoaXRlY3R1cmUubmFtZX0gaXMgbm90IHN1cHBvcnRlZCBvbiBGYXJnYXRlYCk7XG4gICAgfVxuXG4gICAgbGV0IG9zOiBlY3MuT3BlcmF0aW5nU3lzdGVtRmFtaWx5O1xuICAgIGlmIChpbWFnZS5vcy5pc0luKE9zLl9BTExfTElOVVhfVkVSU0lPTlMpKSB7XG4gICAgICBvcyA9IGVjcy5PcGVyYXRpbmdTeXN0ZW1GYW1pbHkuTElOVVg7XG4gICAgfSBlbHNlIGlmIChpbWFnZS5vcy5pcyhPcy5XSU5ET1dTKSkge1xuICAgICAgb3MgPSBlY3MuT3BlcmF0aW5nU3lzdGVtRmFtaWx5LldJTkRPV1NfU0VSVkVSXzIwMTlfQ09SRTtcbiAgICAgIGlmIChwcm9wcz8uZXBoZW1lcmFsU3RvcmFnZUdpQikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VwaGVtZXJhbCBzdG9yYWdlIGlzIG5vdCBzdXBwb3J0ZWQgb24gRmFyZ2F0ZSBXaW5kb3dzJyk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtpbWFnZS5vcy5uYW1lfSBpcyBub3Qgc3VwcG9ydGVkIG9uIEZhcmdhdGVgKTtcbiAgICB9XG5cbiAgICB0aGlzLmxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ2xvZ3MnLCB7XG4gICAgICByZXRlbnRpb246IHByb3BzPy5sb2dSZXRlbnRpb24gPz8gUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICB0aGlzLnRhc2sgPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICAndGFzaycsXG4gICAgICB7XG4gICAgICAgIGNwdTogcHJvcHM/LmNwdSA/PyAxMDI0LFxuICAgICAgICBtZW1vcnlMaW1pdE1pQjogcHJvcHM/Lm1lbW9yeUxpbWl0TWlCID8/IDIwNDgsXG4gICAgICAgIGVwaGVtZXJhbFN0b3JhZ2VHaUI6IHByb3BzPy5lcGhlbWVyYWxTdG9yYWdlR2lCID8/ICghaW1hZ2Uub3MuaXMoT3MuV0lORE9XUykgPyAyNSA6IHVuZGVmaW5lZCksXG4gICAgICAgIHJ1bnRpbWVQbGF0Zm9ybToge1xuICAgICAgICAgIG9wZXJhdGluZ1N5c3RlbUZhbWlseTogb3MsXG4gICAgICAgICAgY3B1QXJjaGl0ZWN0dXJlOiBhcmNoLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICApO1xuICAgIHRoaXMuY29udGFpbmVyID0gdGhpcy50YXNrLmFkZENvbnRhaW5lcihcbiAgICAgICdydW5uZXInLFxuICAgICAge1xuICAgICAgICBpbWFnZTogZWNzLkFzc2V0SW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoaW1hZ2UuaW1hZ2VSZXBvc2l0b3J5LCBpbWFnZS5pbWFnZVRhZyksXG4gICAgICAgIGxvZ2dpbmc6IGVjcy5Bd3NMb2dEcml2ZXIuYXdzTG9ncyh7XG4gICAgICAgICAgbG9nR3JvdXA6IHRoaXMubG9nR3JvdXAsXG4gICAgICAgICAgc3RyZWFtUHJlZml4OiAncnVubmVyJyxcbiAgICAgICAgfSksXG4gICAgICAgIGNvbW1hbmQ6IGVjc1J1bkNvbW1hbmQodGhpcy5pbWFnZS5vcywgZmFsc2UpLFxuICAgICAgICB1c2VyOiBpbWFnZS5vcy5pcyhPcy5XSU5ET1dTKSA/IHVuZGVmaW5lZCA6ICdydW5uZXInLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgdGhpcy5ncmFudFByaW5jaXBhbCA9IHRoaXMudGFzay50YXNrUm9sZTtcblxuICAgIC8vIGFsbG93IFNTTSBTZXNzaW9uIE1hbmFnZXJcbiAgICB0aGlzLnRhc2sudGFza1JvbGUuYWRkVG9QcmluY2lwYWxQb2xpY3koTUlOSU1BTF9TU01fU0VTU0lPTl9NQU5BR0VSX1BPTElDWV9TVEFURU1FTlQpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlIHN0ZXAgZnVuY3Rpb24gdGFzayhzKSB0byBzdGFydCBhIG5ldyBydW5uZXIuXG4gICAqXG4gICAqIENhbGxlZCBieSBHaXRodWJSdW5uZXJzIGFuZCBzaG91bGRuJ3QgYmUgY2FsbGVkIG1hbnVhbGx5LlxuICAgKlxuICAgKiBAcGFyYW0gcGFyYW1ldGVycyB3b3JrZmxvdyBqb2IgZGV0YWlsc1xuICAgKi9cbiAgZ2V0U3RlcEZ1bmN0aW9uVGFzayhwYXJhbWV0ZXJzOiBSdW5uZXJSdW50aW1lUGFyYW1ldGVycyk6IHN0ZXBmdW5jdGlvbnMuSUNoYWluYWJsZSB7XG4gICAgcmV0dXJuIG5ldyBzdGVwZnVuY3Rpb25zX3Rhc2tzLkVjc1J1blRhc2soXG4gICAgICB0aGlzLFxuICAgICAgJ1N0YXRlJyxcbiAgICAgIHtcbiAgICAgICAgc3RhdGVOYW1lOiBnZW5lcmF0ZVN0YXRlTmFtZSh0aGlzKSxcbiAgICAgICAgaW50ZWdyYXRpb25QYXR0ZXJuOiBJbnRlZ3JhdGlvblBhdHRlcm4uUlVOX0pPQiwgLy8gc3luY1xuICAgICAgICB0YXNrRGVmaW5pdGlvbjogdGhpcy50YXNrLFxuICAgICAgICBjbHVzdGVyOiB0aGlzLmNsdXN0ZXIsXG4gICAgICAgIGxhdW5jaFRhcmdldDogbmV3IEVjc0ZhcmdhdGVMYXVuY2hUYXJnZXQoe1xuICAgICAgICAgIHNwb3Q6IHRoaXMuc3BvdCxcbiAgICAgICAgfSksXG4gICAgICAgIGVuYWJsZUV4ZWN1dGVDb21tYW5kOiB0aGlzLmltYWdlLm9zLmlzSW4oT3MuX0FMTF9MSU5VWF9WRVJTSU9OUyksXG4gICAgICAgIHN1Ym5ldHM6IHRoaXMuc3VibmV0U2VsZWN0aW9uLFxuICAgICAgICBhc3NpZ25QdWJsaWNJcDogdGhpcy5hc3NpZ25QdWJsaWNJcCxcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHMsXG4gICAgICAgIGNvbnRhaW5lck92ZXJyaWRlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNvbnRhaW5lckRlZmluaXRpb246IHRoaXMuY29udGFpbmVyLFxuICAgICAgICAgICAgZW52aXJvbm1lbnQ6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5hbWU6ICdSVU5ORVJfVE9LRU4nLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBwYXJhbWV0ZXJzLnJ1bm5lclRva2VuUGF0aCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5hbWU6ICdSVU5ORVJfTkFNRScsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMucnVubmVyTmFtZVBhdGgsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUlVOTkVSX0xBQkVMJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogcGFyYW1ldGVycy5sYWJlbHNQYXRoLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ1JVTk5FUl9HUk9VUDEnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiB0aGlzLmdyb3VwID8gJy0tcnVubmVyZ3JvdXAnIDogJycsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUlVOTkVSX0dST1VQMicsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHRoaXMuZ3JvdXAgPyB0aGlzLmdyb3VwIDogJycsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnREVGQVVMVF9MQUJFTFMnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiB0aGlzLmRlZmF1bHRMYWJlbHMgPyAnJyA6ICctLW5vLWRlZmF1bHQtbGFiZWxzJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG5hbWU6ICdHSVRIVUJfRE9NQUlOJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogcGFyYW1ldGVycy5naXRodWJEb21haW5QYXRoLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgbmFtZTogJ09XTkVSJyxcbiAgICAgICAgICAgICAgICB2YWx1ZTogcGFyYW1ldGVycy5vd25lclBhdGgsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUkVQTycsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMucmVwb1BhdGgsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBuYW1lOiAnUkVHSVNUUkFUSU9OX1VSTCcsXG4gICAgICAgICAgICAgICAgdmFsdWU6IHBhcmFtZXRlcnMucmVnaXN0cmF0aW9uVXJsLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICApO1xuICB9XG5cbiAgZ3JhbnRTdGF0ZU1hY2hpbmUoXzogaWFtLklHcmFudGFibGUpIHtcbiAgfVxuXG4gIHN0YXR1cyhzdGF0dXNGdW5jdGlvblJvbGU6IGlhbS5JR3JhbnRhYmxlKTogSVJ1bm5lclByb3ZpZGVyU3RhdHVzIHtcbiAgICB0aGlzLmltYWdlLmltYWdlUmVwb3NpdG9yeS5ncmFudChzdGF0dXNGdW5jdGlvblJvbGUsICdlY3I6RGVzY3JpYmVJbWFnZXMnKTtcblxuICAgIHJldHVybiB7XG4gICAgICB0eXBlOiB0aGlzLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICBsYWJlbHM6IHRoaXMubGFiZWxzLFxuICAgICAgY29uc3RydWN0UGF0aDogdGhpcy5ub2RlLnBhdGgsXG4gICAgICB2cGNBcm46IHRoaXMudnBjPy52cGNBcm4sXG4gICAgICBzZWN1cml0eUdyb3VwczogdGhpcy5zZWN1cml0eUdyb3Vwcy5tYXAoc2cgPT4gc2cuc2VjdXJpdHlHcm91cElkKSxcbiAgICAgIHJvbGVBcm46IHRoaXMudGFzay50YXNrUm9sZS5yb2xlQXJuLFxuICAgICAgbG9nR3JvdXA6IHRoaXMubG9nR3JvdXAubG9nR3JvdXBOYW1lLFxuICAgICAgaW1hZ2U6IHtcbiAgICAgICAgaW1hZ2VSZXBvc2l0b3J5OiB0aGlzLmltYWdlLmltYWdlUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgICBpbWFnZVRhZzogdGhpcy5pbWFnZS5pbWFnZVRhZyxcbiAgICAgICAgaW1hZ2VCdWlsZGVyTG9nR3JvdXA6IHRoaXMuaW1hZ2UubG9nR3JvdXA/LmxvZ0dyb3VwTmFtZSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEBkZXByZWNhdGVkIHVzZSB7QGxpbmsgRmFyZ2F0ZVJ1bm5lclByb3ZpZGVyfVxuICovXG5leHBvcnQgY2xhc3MgRmFyZ2F0ZVJ1bm5lciBleHRlbmRzIEZhcmdhdGVSdW5uZXJQcm92aWRlciB7XG59XG4iXX0=