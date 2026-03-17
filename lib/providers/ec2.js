"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Ec2Runner = exports.Ec2RunnerProvider = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const cdk = require("aws-cdk-lib");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const aws_stepfunctions_1 = require("aws-cdk-lib/aws-stepfunctions");
const common_1 = require("./common");
const image_builders_1 = require("../image-builders");
const aws_image_builder_1 = require("../image-builders/aws-image-builder");
const utils_1 = require("../utils");
// this script is specifically made so `poweroff` is absolutely always called
// each `{}` is a variable coming from `params` below
const linuxUserDataTemplate = `#!/bin/bash -x
TASK_TOKEN="{}"
logGroupName="{}"
runnerNamePath="{}"
githubDomainPath="{}"
ownerPath="{}"
repoPath="{}"
runnerTokenPath="{}"
labels="{}"
registrationURL="{}"
runnerGroup1="{}"
runnerGroup2="{}"
defaultLabels="{}"

export AWS_RETRY_MODE=standard # better retry

heartbeat () {
  while true; do
    aws stepfunctions send-task-heartbeat --task-token "$TASK_TOKEN"
    sleep 60
  done
}
setup_logs () {
  cat <<EOF > /tmp/log.conf || exit 1
  {
    "logs": {
      "log_stream_name": "unknown",
      "logs_collected": {
        "files": {
          "collect_list": [
            {
              "file_path": "/var/log/runner.log",
              "log_group_name": "$logGroupName",
              "log_stream_name": "$runnerNamePath",
              "timezone": "UTC"
            }
          ]
        }
      }
    }
  }
EOF
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/tmp/log.conf || exit 2
}
action () {
  # Determine the value of RUNNER_FLAGS
  if [ "$(< /home/runner/RUNNER_VERSION)" = "latest" ]; then
    RUNNER_FLAGS=""
  else
    RUNNER_FLAGS="--disableupdate"
  fi

  labelsTemplate="$labels,cdkghr:started:$(date +%s)"

  # Execute the configuration command for runner registration
  sudo -Hu runner /home/runner/config.sh --unattended --url "$registrationURL" --token "$runnerTokenPath" --ephemeral --work _work --labels "$labelsTemplate" $RUNNER_FLAGS --name "$runnerNamePath" $runnerGroup1 $runnerGroup2 $defaultLabels || exit 1

  # Execute the run command
  sudo --preserve-env=AWS_REGION -Hu runner /home/runner/run.sh || exit 2

  # Retrieve the status
  STATUS=$(grep -Phors "finish job request for job [0-9a-f-]+ with result: .*" /home/runner/_diag/ | tail -n1 | awk '{print $NF}')

  # Check and print the job status
  [ -n "$STATUS" ] && echo CDKGHA JOB DONE "$labels" "$STATUS"
}
heartbeat &
if setup_logs && action |& tee /var/log/runner.log; then
  aws stepfunctions send-task-success --task-token "$TASK_TOKEN" --task-output '{"ok": true}' |& tee -a /var/log/runner.log
else
  aws stepfunctions send-task-failure --task-token "$TASK_TOKEN" |& tee -a /var/log/runner.log
fi
sleep 10  # give cloudwatch agent its default 5 seconds buffer duration to upload logs
poweroff
`.replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\\{\\}/g, '{}');
// this script is specifically made so `poweroff` is absolutely always called
// each `{}` is a variable coming from `params` below and their order should match the linux script
const windowsUserDataTemplate = `<powershell>
$TASK_TOKEN = "{}"
$logGroupName="{}"
$runnerNamePath="{}"
$githubDomainPath="{}"
$ownerPath="{}"
$repoPath="{}"
$runnerTokenPath="{}"
$labels="{}"
$registrationURL="{}"
$runnerGroup1="{}"
$runnerGroup2="{}"
$defaultLabels="{}"

$Env:AWS_RETRY_MODE = "standard"  # better retry

# EC2Launch only starts ssm agent after user data is done, so we need to start it ourselves (it is disabled by default)
Set-Service -StartupType Manual AmazonSSMAgent
Start-Service AmazonSSMAgent

Start-Job -ScriptBlock {
  while (1) {
    aws stepfunctions send-task-heartbeat --task-token "$using:TASK_TOKEN"
    sleep 60
  }
}
function setup_logs () {
  echo "{
    \`"logs\`": {
      \`"log_stream_name\`": \`"unknown\`",
      \`"logs_collected\`": {
        \`"files\`": {
         \`"collect_list\`": [
            {
              \`"file_path\`": \`"/actions/runner.log\`",
              \`"log_group_name\`": \`"$logGroupName\`",
              \`"log_stream_name\`": \`"$runnerNamePath\`",
              \`"timezone\`": \`"UTC\`"
            }
          ]
        }
      }
    }
  }" | Out-File -Encoding ASCII $Env:TEMP/log.conf
  & "C:/Program Files/Amazon/AmazonCloudWatchAgent/amazon-cloudwatch-agent-ctl.ps1" -a fetch-config -m ec2 -s -c file:$Env:TEMP/log.conf
}
function action () {
  cd /actions
  $RunnerVersion = Get-Content /actions/RUNNER_VERSION -Raw
  if ($RunnerVersion -eq "latest") { $RunnerFlags = "" } else { $RunnerFlags = "--disableupdate" }
  ./config.cmd --unattended --url "\${registrationUrl}" --token "\${runnerTokenPath}" --ephemeral --work _work --labels "\${labels},cdkghr:started:$(Get-Date -UFormat +%s)" $RunnerFlags --name "\${runnerNamePath}" \${runnerGroup1} \${runnerGroup2} \${defaultLabels} 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log

  if ($LASTEXITCODE -ne 0) { return 1 }
  ./run.cmd 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log
  if ($LASTEXITCODE -ne 0) { return 2 }

  $STATUS = Select-String -Path './_diag/*.log' -Pattern 'finish job request for job [0-9a-f\\-]+ with result: (.*)' | %{$_.Matches.Groups[1].Value} | Select-Object -Last 1

  if ($STATUS) {
      echo "CDKGHA JOB DONE \${labels} $STATUS" | Out-File -Encoding ASCII -Append /actions/runner.log
  }

  return 0
}
setup_logs
$r = action
if ($r -eq 0) {
  aws stepfunctions send-task-success --task-token "$TASK_TOKEN" --task-output '{ }' 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log
} else {
  aws stepfunctions send-task-failure --task-token "$TASK_TOKEN" 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log
}
Start-Sleep -Seconds 10  # give cloudwatch agent its default 5 seconds buffer duration to upload logs
Stop-Computer -ComputerName localhost -Force
</powershell>
`.replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\\{\\}/g, '{}');
/**
 * GitHub Actions runner provider using EC2 to execute jobs.
 *
 * This construct is not meant to be used by itself. It should be passed in the providers property for GitHubRunners.
 */
class Ec2RunnerProvider extends common_1.BaseProvider {
    /**
     * Create new image builder that builds EC2 specific runner images.
     *
     * You can customize the OS, architecture, VPC, subnet, security groups, etc. by passing in props.
     *
     * You can add components to the image builder by calling `imageBuilder.addComponent()`.
     *
     * The default OS is Ubuntu running on x64 architecture.
     *
     * Included components:
     *  * `RunnerImageComponent.requiredPackages()`
     *  * `RunnerImageComponent.cloudWatchAgent()`
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
            builderType: image_builders_1.RunnerImageBuilderType.AWS_IMAGE_BUILDER,
            components: [
                image_builders_1.RunnerImageComponent.requiredPackages(),
                image_builders_1.RunnerImageComponent.cloudWatchAgent(),
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
            'Ec2.Ec2Exception',
            'States.Timeout',
        ];
        this.labels = props?.labels ?? ['ec2'];
        this.group = props?.group;
        this.vpc = props?.vpc ?? aws_cdk_lib_1.aws_ec2.Vpc.fromLookup(this, 'Default VPC', { isDefault: true });
        this.securityGroups = props?.securityGroup ? [props.securityGroup] : (props?.securityGroups ?? [new aws_cdk_lib_1.aws_ec2.SecurityGroup(this, 'SG', { vpc: this.vpc })]);
        this.subnets = props?.subnet ? [props.subnet] : this.vpc.selectSubnets(props?.subnetSelection).subnets;
        this.instanceType = props?.instanceType ?? aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.M6I, aws_cdk_lib_1.aws_ec2.InstanceSize.LARGE);
        this.nestedVirtualization = props?.nestedVirtualization;
        this.storageSize = props?.storageSize ?? cdk.Size.gibibytes(30); // 30 is the minimum for Windows
        this.storageOptions = props?.storageOptions;
        this.spot = props?.spot ?? false;
        this.spotMaxPrice = props?.spotMaxPrice;
        this.defaultLabels = props?.defaultLabels ?? true;
        const arch = this.instanceType.architecture === aws_cdk_lib_1.aws_ec2.InstanceArchitecture.ARM_64 ? common_1.Architecture.ARM64 : common_1.Architecture.X86_64;
        this.amiBuilder = props?.imageBuilder ?? props?.amiBuilder ?? Ec2RunnerProvider.imageBuilder(this, 'Ami Builder', {
            vpc: props?.vpc,
            subnetSelection: props?.subnetSelection,
            securityGroups: this.securityGroups,
            baseAmi: (0, utils_1.isGpuInstanceType)(this.instanceType) ? aws_image_builder_1.BaseImage.fromGpuBase(common_1.Os.LINUX_UBUNTU, arch) : undefined,
            architecture: arch,
            awsImageBuilderOptions: {
                instanceType: arch.is(common_1.Architecture.ARM64) ? aws_cdk_lib_1.aws_ec2.InstanceType.of(aws_cdk_lib_1.aws_ec2.InstanceClass.M6G, aws_cdk_lib_1.aws_ec2.InstanceSize.LARGE) : undefined,
            },
        });
        this.ami = this.amiBuilder.bindAmi();
        if (this.amiBuilder instanceof image_builders_1.AwsImageBuilderRunnerImageBuilder) {
            if (this.amiBuilder.storageSize && this.storageSize.toBytes() < this.amiBuilder.storageSize.toBytes()) {
                throw new Error(`Runner storage size (${this.storageSize.toGibibytes()} GiB) must be at least the same as the image builder storage size (${this.amiBuilder.storageSize.toGibibytes()} GiB)`);
            }
        }
        if (!this.ami.architecture.instanceTypeMatch(this.instanceType)) {
            throw new Error(`AMI architecture (${this.ami.architecture.name}) doesn't match runner instance type (${this.instanceType} / ${this.instanceType.architecture})`);
        }
        this.grantPrincipal = this.role = new aws_cdk_lib_1.aws_iam.Role(this, 'Role', {
            assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        this.grantPrincipal.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['states:SendTaskFailure', 'states:SendTaskSuccess', 'states:SendTaskHeartbeat'],
            resources: ['*'], // no support for stateMachine.stateMachineArn but task tokens are very long and totally random so not the end of the world
        }));
        this.grantPrincipal.addToPrincipalPolicy(utils_1.MINIMAL_EC2_SSM_SESSION_MANAGER_POLICY_STATEMENT);
        this.logGroup = new aws_cdk_lib_1.aws_logs.LogGroup(this, 'Logs', {
            retention: props?.logRetention ?? aws_logs_1.RetentionDays.ONE_MONTH,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        this.logGroup.grantWrite(this);
    }
    /**
     * Generate step function task(s) to start a new runner.
     *
     * Called by GithubRunners and shouldn't be called manually.
     *
     * @param parameters workflow job details
     */
    getStepFunctionTask(parameters) {
        // we need to build user data in two steps because passing the template as the first parameter to stepfunctions.JsonPath.format fails on syntax
        const params = [
            aws_cdk_lib_1.aws_stepfunctions.JsonPath.taskToken,
            this.logGroup.logGroupName,
            parameters.runnerNamePath,
            parameters.githubDomainPath,
            parameters.ownerPath,
            parameters.repoPath,
            parameters.runnerTokenPath,
            parameters.labelsPath,
            parameters.registrationUrl,
            this.group ? '--runnergroup' : '',
            // this is split into 2 for powershell otherwise it will pass "--runnergroup name" as a single argument and config.sh will fail
            this.group ? this.group : '',
            this.defaultLabels ? '' : '--no-default-labels',
        ];
        const passUserData = new aws_cdk_lib_1.aws_stepfunctions.Pass(this, 'Data', {
            stateName: (0, common_1.generateStateName)(this, 'data'),
            parameters: {
                userdataTemplate: this.ami.os.is(common_1.Os.WINDOWS) ? windowsUserDataTemplate : linuxUserDataTemplate,
            },
            resultPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.ec2'),
        });
        // we use ec2:RunInstances because we must
        // we can't use fleets because they don't let us override user data, security groups or even disk size
        // we can't use requestSpotInstances because it doesn't support launch templates, and it's deprecated
        // ec2:RunInstances also seemed like the only one to immediately return an error when spot capacity is not available
        // we build a complicated chain of states here because ec2:RunInstances can only try one subnet at a time
        // if someone can figure out a good way to use Map for this, please open a PR
        // build a state for each subnet we want to try
        const instanceProfile = new aws_cdk_lib_1.aws_iam.CfnInstanceProfile(this, 'Instance Profile', {
            roles: [this.role.roleName],
        });
        const rootDeviceResource = (0, common_1.amiRootDevice)(this, this.ami.launchTemplate.launchTemplateId);
        rootDeviceResource.node.addDependency(this.amiBuilder);
        const subnetRunners = this.subnets.map(subnet => {
            return new aws_cdk_lib_1.aws_stepfunctions_tasks.CallAwsService(this, subnet.subnetId, {
                stateName: (0, common_1.generateStateName)(this, subnet.subnetId),
                comment: subnet.availabilityZone,
                integrationPattern: aws_stepfunctions_1.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
                service: 'ec2',
                action: 'runInstances',
                heartbeatTimeout: aws_cdk_lib_1.aws_stepfunctions.Timeout.duration(aws_cdk_lib_1.Duration.minutes(10)),
                parameters: {
                    LaunchTemplate: {
                        LaunchTemplateId: this.ami.launchTemplate.launchTemplateId,
                    },
                    MinCount: 1,
                    MaxCount: 1,
                    InstanceType: this.instanceType.toString(),
                    UserData: aws_cdk_lib_1.aws_stepfunctions.JsonPath.base64Encode(aws_cdk_lib_1.aws_stepfunctions.JsonPath.format(aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.ec2.userdataTemplate'), ...params)),
                    InstanceInitiatedShutdownBehavior: aws_cdk_lib_1.aws_ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
                    IamInstanceProfile: {
                        Arn: instanceProfile.attrArn,
                    },
                    MetadataOptions: {
                        HttpTokens: 'required',
                    },
                    CpuOptions: this.nestedVirtualization === undefined ? undefined : {
                        NestedVirtualization: this.nestedVirtualization ? 'enabled' : 'disabled',
                    },
                    SecurityGroupIds: this.securityGroups.map(sg => sg.securityGroupId),
                    SubnetId: subnet.subnetId,
                    BlockDeviceMappings: [{
                            DeviceName: rootDeviceResource.ref,
                            Ebs: {
                                DeleteOnTermination: true,
                                VolumeSize: this.storageSize.toGibibytes(),
                                VolumeType: this.storageOptions?.volumeType,
                                Iops: this.storageOptions?.iops,
                                Throughput: this.storageOptions?.throughput,
                            },
                        }],
                    InstanceMarketOptions: this.spot ? {
                        MarketType: 'spot',
                        SpotOptions: {
                            MaxPrice: this.spotMaxPrice,
                            SpotInstanceType: 'one-time',
                        },
                    } : undefined,
                    TagSpecifications: ['instance', 'volume'].map(resType => {
                        return {
                            ResourceType: resType,
                            Tags: [
                                {
                                    Key: 'Name',
                                    Value: parameters.runnerNamePath,
                                },
                                {
                                    Key: 'GitHubRunners:Provider',
                                    Value: this.node.path,
                                },
                                {
                                    Key: 'GitHubRunners:Repo',
                                    Value: aws_cdk_lib_1.aws_stepfunctions.JsonPath.format('{}/{}', parameters.ownerPath, parameters.repoPath),
                                },
                                {
                                    Key: 'GitHubRunners:Labels',
                                    Value: parameters.labelsPath,
                                },
                            ],
                        };
                    }),
                },
                iamResources: ['*'],
            });
        });
        // start with the first subnet
        passUserData.next(subnetRunners[0]);
        // chain up the rest of the subnets
        for (let i = 1; i < subnetRunners.length; i++) {
            subnetRunners[i - 1].addCatch(subnetRunners[i], {
                errors: ['Ec2.Ec2Exception', 'States.Timeout'],
                resultPath: aws_cdk_lib_1.aws_stepfunctions.JsonPath.stringAt('$.lastSubnetError'),
            });
        }
        return passUserData;
    }
    grantStateMachine(stateMachineRole) {
        stateMachineRole.grantPrincipal.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [this.role.roleArn],
            conditions: {
                StringEquals: {
                    'iam:PassedToService': 'ec2.amazonaws.com',
                },
            },
        }));
        stateMachineRole.grantPrincipal.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['ec2:createTags'],
            resources: [aws_cdk_lib_1.Stack.of(this).formatArn({
                    service: 'ec2',
                    resource: '*',
                })],
        }));
        stateMachineRole.grantPrincipal.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['iam:CreateServiceLinkedRole'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'iam:AWSServiceName': 'spot.amazonaws.com',
                },
            },
        }));
    }
    status(statusFunctionRole) {
        statusFunctionRole.grantPrincipal.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ['ec2:DescribeLaunchTemplateVersions'],
            resources: ['*'],
        }));
        return {
            type: this.constructor.name,
            labels: this.labels,
            constructPath: this.node.path,
            securityGroups: this.securityGroups.map(sg => sg.securityGroupId),
            roleArn: this.role.roleArn,
            logGroup: this.logGroup.logGroupName,
            ami: {
                launchTemplate: this.ami.launchTemplate.launchTemplateId || 'unknown',
                amiBuilderLogGroup: this.ami.logGroup?.logGroupName,
            },
        };
    }
    /**
     * The network connections associated with this resource.
     */
    get connections() {
        return new aws_cdk_lib_1.aws_ec2.Connections({ securityGroups: this.securityGroups });
    }
}
exports.Ec2RunnerProvider = Ec2RunnerProvider;
_a = JSII_RTTI_SYMBOL_1;
Ec2RunnerProvider[_a] = { fqn: "@cloudsnorkel/cdk-github-runners.Ec2RunnerProvider", version: "0.0.0" };
/**
 * @deprecated use {@link Ec2RunnerProvider}
 */
class Ec2Runner extends Ec2RunnerProvider {
}
exports.Ec2Runner = Ec2Runner;
_b = JSII_RTTI_SYMBOL_1;
Ec2Runner[_b] = { fqn: "@cloudsnorkel/cdk-github-runners.Ec2Runner", version: "0.0.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWMyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3Byb3ZpZGVycy9lYzIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSxtQ0FBbUM7QUFDbkMsNkNBU3FCO0FBQ3JCLG1EQUFxRDtBQUNyRCxxRUFBbUU7QUFFbkUscUNBYWtCO0FBQ2xCLHNEQU8yQjtBQUMzQiwyRUFBZ0U7QUFDaEUsb0NBQStGO0FBRS9GLDZFQUE2RTtBQUM3RSxxREFBcUQ7QUFDckQsTUFBTSxxQkFBcUIsR0FBRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EwRTdCLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFFckUsNkVBQTZFO0FBQzdFLG1HQUFtRztBQUNuRyxNQUFNLHVCQUF1QixHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBFL0IsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsQ0FBQztBQXVJckU7Ozs7R0FJRztBQUNILE1BQWEsaUJBQWtCLFNBQVEscUJBQVk7SUFDakQ7Ozs7Ozs7Ozs7Ozs7Ozs7OztPQWtCRztJQUNJLE1BQU0sQ0FBQyxZQUFZLENBQUMsS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBK0I7UUFDdEYsT0FBTyxtQ0FBa0IsQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRTtZQUN2QyxFQUFFLEVBQUUsV0FBRSxDQUFDLFlB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LE1BQWEsU0FBVSxTQUFRLGlCQUFpQjs7QUFBaEQsOEJBQ0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHtcbiAgYXdzX2VjMiBhcyBlYzIsXG4gIGF3c19pYW0gYXMgaWFtLFxuICBhd3NfbG9ncyBhcyBsb2dzLFxuICBhd3Nfc3RlcGZ1bmN0aW9ucyBhcyBzdGVwZnVuY3Rpb25zLFxuICBhd3Nfc3RlcGZ1bmN0aW9uc190YXNrcyBhcyBzdGVwZnVuY3Rpb25zX3Rhc2tzLFxuICBEdXJhdGlvbixcbiAgUmVtb3ZhbFBvbGljeSxcbiAgU3RhY2ssXG59IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFJldGVudGlvbkRheXMgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgeyBJbnRlZ3JhdGlvblBhdHRlcm4gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3RlcGZ1bmN0aW9ucyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7XG4gIGFtaVJvb3REZXZpY2UsXG4gIEFyY2hpdGVjdHVyZSxcbiAgQmFzZVByb3ZpZGVyLFxuICBJUnVubmVyUHJvdmlkZXIsXG4gIElSdW5uZXJQcm92aWRlclN0YXR1cyxcbiAgT3MsXG4gIFJ1bm5lckFtaSxcbiAgUnVubmVyUHJvdmlkZXJQcm9wcyxcbiAgUnVubmVyUnVudGltZVBhcmFtZXRlcnMsXG4gIFJ1bm5lclZlcnNpb24sXG4gIGdlbmVyYXRlU3RhdGVOYW1lLFxuICBTdG9yYWdlT3B0aW9ucyxcbn0gZnJvbSAnLi9jb21tb24nO1xuaW1wb3J0IHtcbiAgQXdzSW1hZ2VCdWlsZGVyUnVubmVySW1hZ2VCdWlsZGVyLFxuICBJUnVubmVySW1hZ2VCdWlsZGVyLFxuICBSdW5uZXJJbWFnZUJ1aWxkZXIsXG4gIFJ1bm5lckltYWdlQnVpbGRlclByb3BzLFxuICBSdW5uZXJJbWFnZUJ1aWxkZXJUeXBlLFxuICBSdW5uZXJJbWFnZUNvbXBvbmVudCxcbn0gZnJvbSAnLi4vaW1hZ2UtYnVpbGRlcnMnO1xuaW1wb3J0IHsgQmFzZUltYWdlIH0gZnJvbSAnLi4vaW1hZ2UtYnVpbGRlcnMvYXdzLWltYWdlLWJ1aWxkZXInO1xuaW1wb3J0IHsgaXNHcHVJbnN0YW5jZVR5cGUsIE1JTklNQUxfRUMyX1NTTV9TRVNTSU9OX01BTkFHRVJfUE9MSUNZX1NUQVRFTUVOVCB9IGZyb20gJy4uL3V0aWxzJztcblxuLy8gdGhpcyBzY3JpcHQgaXMgc3BlY2lmaWNhbGx5IG1hZGUgc28gYHBvd2Vyb2ZmYCBpcyBhYnNvbHV0ZWx5IGFsd2F5cyBjYWxsZWRcbi8vIGVhY2ggYHt9YCBpcyBhIHZhcmlhYmxlIGNvbWluZyBmcm9tIGBwYXJhbXNgIGJlbG93XG5jb25zdCBsaW51eFVzZXJEYXRhVGVtcGxhdGUgPSBgIyEvYmluL2Jhc2ggLXhcblRBU0tfVE9LRU49XCJ7fVwiXG5sb2dHcm91cE5hbWU9XCJ7fVwiXG5ydW5uZXJOYW1lUGF0aD1cInt9XCJcbmdpdGh1YkRvbWFpblBhdGg9XCJ7fVwiXG5vd25lclBhdGg9XCJ7fVwiXG5yZXBvUGF0aD1cInt9XCJcbnJ1bm5lclRva2VuUGF0aD1cInt9XCJcbmxhYmVscz1cInt9XCJcbnJlZ2lzdHJhdGlvblVSTD1cInt9XCJcbnJ1bm5lckdyb3VwMT1cInt9XCJcbnJ1bm5lckdyb3VwMj1cInt9XCJcbmRlZmF1bHRMYWJlbHM9XCJ7fVwiXG5cbmV4cG9ydCBBV1NfUkVUUllfTU9ERT1zdGFuZGFyZCAjIGJldHRlciByZXRyeVxuXG5oZWFydGJlYXQgKCkge1xuICB3aGlsZSB0cnVlOyBkb1xuICAgIGF3cyBzdGVwZnVuY3Rpb25zIHNlbmQtdGFzay1oZWFydGJlYXQgLS10YXNrLXRva2VuIFwiJFRBU0tfVE9LRU5cIlxuICAgIHNsZWVwIDYwXG4gIGRvbmVcbn1cbnNldHVwX2xvZ3MgKCkge1xuICBjYXQgPDxFT0YgPiAvdG1wL2xvZy5jb25mIHx8IGV4aXQgMVxuICB7XG4gICAgXCJsb2dzXCI6IHtcbiAgICAgIFwibG9nX3N0cmVhbV9uYW1lXCI6IFwidW5rbm93blwiLFxuICAgICAgXCJsb2dzX2NvbGxlY3RlZFwiOiB7XG4gICAgICAgIFwiZmlsZXNcIjoge1xuICAgICAgICAgIFwiY29sbGVjdF9saXN0XCI6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgXCJmaWxlX3BhdGhcIjogXCIvdmFyL2xvZy9ydW5uZXIubG9nXCIsXG4gICAgICAgICAgICAgIFwibG9nX2dyb3VwX25hbWVcIjogXCIkbG9nR3JvdXBOYW1lXCIsXG4gICAgICAgICAgICAgIFwibG9nX3N0cmVhbV9uYW1lXCI6IFwiJHJ1bm5lck5hbWVQYXRoXCIsXG4gICAgICAgICAgICAgIFwidGltZXpvbmVcIjogXCJVVENcIlxuICAgICAgICAgICAgfVxuICAgICAgICAgIF1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuRU9GXG4gIC9vcHQvYXdzL2FtYXpvbi1jbG91ZHdhdGNoLWFnZW50L2Jpbi9hbWF6b24tY2xvdWR3YXRjaC1hZ2VudC1jdGwgLWEgZmV0Y2gtY29uZmlnIC1tIGVjMiAtcyAtYyBmaWxlOi90bXAvbG9nLmNvbmYgfHwgZXhpdCAyXG59XG5hY3Rpb24gKCkge1xuICAjIERldGVybWluZSB0aGUgdmFsdWUgb2YgUlVOTkVSX0ZMQUdTXG4gIGlmIFsgXCIkKDwgL2hvbWUvcnVubmVyL1JVTk5FUl9WRVJTSU9OKVwiID0gXCJsYXRlc3RcIiBdOyB0aGVuXG4gICAgUlVOTkVSX0ZMQUdTPVwiXCJcbiAgZWxzZVxuICAgIFJVTk5FUl9GTEFHUz1cIi0tZGlzYWJsZXVwZGF0ZVwiXG4gIGZpXG5cbiAgbGFiZWxzVGVtcGxhdGU9XCIkbGFiZWxzLGNka2docjpzdGFydGVkOiQoZGF0ZSArJXMpXCJcblxuICAjIEV4ZWN1dGUgdGhlIGNvbmZpZ3VyYXRpb24gY29tbWFuZCBmb3IgcnVubmVyIHJlZ2lzdHJhdGlvblxuICBzdWRvIC1IdSBydW5uZXIgL2hvbWUvcnVubmVyL2NvbmZpZy5zaCAtLXVuYXR0ZW5kZWQgLS11cmwgXCIkcmVnaXN0cmF0aW9uVVJMXCIgLS10b2tlbiBcIiRydW5uZXJUb2tlblBhdGhcIiAtLWVwaGVtZXJhbCAtLXdvcmsgX3dvcmsgLS1sYWJlbHMgXCIkbGFiZWxzVGVtcGxhdGVcIiAkUlVOTkVSX0ZMQUdTIC0tbmFtZSBcIiRydW5uZXJOYW1lUGF0aFwiICRydW5uZXJHcm91cDEgJHJ1bm5lckdyb3VwMiAkZGVmYXVsdExhYmVscyB8fCBleGl0IDFcblxuICAjIEV4ZWN1dGUgdGhlIHJ1biBjb21tYW5kXG4gIHN1ZG8gLS1wcmVzZXJ2ZS1lbnY9QVdTX1JFR0lPTiAtSHUgcnVubmVyIC9ob21lL3J1bm5lci9ydW4uc2ggfHwgZXhpdCAyXG5cbiAgIyBSZXRyaWV2ZSB0aGUgc3RhdHVzXG4gIFNUQVRVUz0kKGdyZXAgLVBob3JzIFwiZmluaXNoIGpvYiByZXF1ZXN0IGZvciBqb2IgWzAtOWEtZi1dKyB3aXRoIHJlc3VsdDogLipcIiAvaG9tZS9ydW5uZXIvX2RpYWcvIHwgdGFpbCAtbjEgfCBhd2sgJ3twcmludCAkTkZ9JylcblxuICAjIENoZWNrIGFuZCBwcmludCB0aGUgam9iIHN0YXR1c1xuICBbIC1uIFwiJFNUQVRVU1wiIF0gJiYgZWNobyBDREtHSEEgSk9CIERPTkUgXCIkbGFiZWxzXCIgXCIkU1RBVFVTXCJcbn1cbmhlYXJ0YmVhdCAmXG5pZiBzZXR1cF9sb2dzICYmIGFjdGlvbiB8JiB0ZWUgL3Zhci9sb2cvcnVubmVyLmxvZzsgdGhlblxuICBhd3Mgc3RlcGZ1bmN0aW9ucyBzZW5kLXRhc2stc3VjY2VzcyAtLXRhc2stdG9rZW4gXCIkVEFTS19UT0tFTlwiIC0tdGFzay1vdXRwdXQgJ3tcIm9rXCI6IHRydWV9JyB8JiB0ZWUgLWEgL3Zhci9sb2cvcnVubmVyLmxvZ1xuZWxzZVxuICBhd3Mgc3RlcGZ1bmN0aW9ucyBzZW5kLXRhc2stZmFpbHVyZSAtLXRhc2stdG9rZW4gXCIkVEFTS19UT0tFTlwiIHwmIHRlZSAtYSAvdmFyL2xvZy9ydW5uZXIubG9nXG5maVxuc2xlZXAgMTAgICMgZ2l2ZSBjbG91ZHdhdGNoIGFnZW50IGl0cyBkZWZhdWx0IDUgc2Vjb25kcyBidWZmZXIgZHVyYXRpb24gdG8gdXBsb2FkIGxvZ3NcbnBvd2Vyb2ZmXG5gLnJlcGxhY2UoL3svZywgJ1xcXFx7JykucmVwbGFjZSgvfS9nLCAnXFxcXH0nKS5yZXBsYWNlKC9cXFxce1xcXFx9L2csICd7fScpO1xuXG4vLyB0aGlzIHNjcmlwdCBpcyBzcGVjaWZpY2FsbHkgbWFkZSBzbyBgcG93ZXJvZmZgIGlzIGFic29sdXRlbHkgYWx3YXlzIGNhbGxlZFxuLy8gZWFjaCBge31gIGlzIGEgdmFyaWFibGUgY29taW5nIGZyb20gYHBhcmFtc2AgYmVsb3cgYW5kIHRoZWlyIG9yZGVyIHNob3VsZCBtYXRjaCB0aGUgbGludXggc2NyaXB0XG5jb25zdCB3aW5kb3dzVXNlckRhdGFUZW1wbGF0ZSA9IGA8cG93ZXJzaGVsbD5cbiRUQVNLX1RPS0VOID0gXCJ7fVwiXG4kbG9nR3JvdXBOYW1lPVwie31cIlxuJHJ1bm5lck5hbWVQYXRoPVwie31cIlxuJGdpdGh1YkRvbWFpblBhdGg9XCJ7fVwiXG4kb3duZXJQYXRoPVwie31cIlxuJHJlcG9QYXRoPVwie31cIlxuJHJ1bm5lclRva2VuUGF0aD1cInt9XCJcbiRsYWJlbHM9XCJ7fVwiXG4kcmVnaXN0cmF0aW9uVVJMPVwie31cIlxuJHJ1bm5lckdyb3VwMT1cInt9XCJcbiRydW5uZXJHcm91cDI9XCJ7fVwiXG4kZGVmYXVsdExhYmVscz1cInt9XCJcblxuJEVudjpBV1NfUkVUUllfTU9ERSA9IFwic3RhbmRhcmRcIiAgIyBiZXR0ZXIgcmV0cnlcblxuIyBFQzJMYXVuY2ggb25seSBzdGFydHMgc3NtIGFnZW50IGFmdGVyIHVzZXIgZGF0YSBpcyBkb25lLCBzbyB3ZSBuZWVkIHRvIHN0YXJ0IGl0IG91cnNlbHZlcyAoaXQgaXMgZGlzYWJsZWQgYnkgZGVmYXVsdClcblNldC1TZXJ2aWNlIC1TdGFydHVwVHlwZSBNYW51YWwgQW1hem9uU1NNQWdlbnRcblN0YXJ0LVNlcnZpY2UgQW1hem9uU1NNQWdlbnRcblxuU3RhcnQtSm9iIC1TY3JpcHRCbG9jayB7XG4gIHdoaWxlICgxKSB7XG4gICAgYXdzIHN0ZXBmdW5jdGlvbnMgc2VuZC10YXNrLWhlYXJ0YmVhdCAtLXRhc2stdG9rZW4gXCIkdXNpbmc6VEFTS19UT0tFTlwiXG4gICAgc2xlZXAgNjBcbiAgfVxufVxuZnVuY3Rpb24gc2V0dXBfbG9ncyAoKSB7XG4gIGVjaG8gXCJ7XG4gICAgXFxgXCJsb2dzXFxgXCI6IHtcbiAgICAgIFxcYFwibG9nX3N0cmVhbV9uYW1lXFxgXCI6IFxcYFwidW5rbm93blxcYFwiLFxuICAgICAgXFxgXCJsb2dzX2NvbGxlY3RlZFxcYFwiOiB7XG4gICAgICAgIFxcYFwiZmlsZXNcXGBcIjoge1xuICAgICAgICAgXFxgXCJjb2xsZWN0X2xpc3RcXGBcIjogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBcXGBcImZpbGVfcGF0aFxcYFwiOiBcXGBcIi9hY3Rpb25zL3J1bm5lci5sb2dcXGBcIixcbiAgICAgICAgICAgICAgXFxgXCJsb2dfZ3JvdXBfbmFtZVxcYFwiOiBcXGBcIiRsb2dHcm91cE5hbWVcXGBcIixcbiAgICAgICAgICAgICAgXFxgXCJsb2dfc3RyZWFtX25hbWVcXGBcIjogXFxgXCIkcnVubmVyTmFtZVBhdGhcXGBcIixcbiAgICAgICAgICAgICAgXFxgXCJ0aW1lem9uZVxcYFwiOiBcXGBcIlVUQ1xcYFwiXG4gICAgICAgICAgICB9XG4gICAgICAgICAgXVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XCIgfCBPdXQtRmlsZSAtRW5jb2RpbmcgQVNDSUkgJEVudjpURU1QL2xvZy5jb25mXG4gICYgXCJDOi9Qcm9ncmFtIEZpbGVzL0FtYXpvbi9BbWF6b25DbG91ZFdhdGNoQWdlbnQvYW1hem9uLWNsb3Vkd2F0Y2gtYWdlbnQtY3RsLnBzMVwiIC1hIGZldGNoLWNvbmZpZyAtbSBlYzIgLXMgLWMgZmlsZTokRW52OlRFTVAvbG9nLmNvbmZcbn1cbmZ1bmN0aW9uIGFjdGlvbiAoKSB7XG4gIGNkIC9hY3Rpb25zXG4gICRSdW5uZXJWZXJzaW9uID0gR2V0LUNvbnRlbnQgL2FjdGlvbnMvUlVOTkVSX1ZFUlNJT04gLVJhd1xuICBpZiAoJFJ1bm5lclZlcnNpb24gLWVxIFwibGF0ZXN0XCIpIHsgJFJ1bm5lckZsYWdzID0gXCJcIiB9IGVsc2UgeyAkUnVubmVyRmxhZ3MgPSBcIi0tZGlzYWJsZXVwZGF0ZVwiIH1cbiAgLi9jb25maWcuY21kIC0tdW5hdHRlbmRlZCAtLXVybCBcIlxcJHtyZWdpc3RyYXRpb25Vcmx9XCIgLS10b2tlbiBcIlxcJHtydW5uZXJUb2tlblBhdGh9XCIgLS1lcGhlbWVyYWwgLS13b3JrIF93b3JrIC0tbGFiZWxzIFwiXFwke2xhYmVsc30sY2RrZ2hyOnN0YXJ0ZWQ6JChHZXQtRGF0ZSAtVUZvcm1hdCArJXMpXCIgJFJ1bm5lckZsYWdzIC0tbmFtZSBcIlxcJHtydW5uZXJOYW1lUGF0aH1cIiBcXCR7cnVubmVyR3JvdXAxfSBcXCR7cnVubmVyR3JvdXAyfSBcXCR7ZGVmYXVsdExhYmVsc30gMj4mMSB8IE91dC1GaWxlIC1FbmNvZGluZyBBU0NJSSAtQXBwZW5kIC9hY3Rpb25zL3J1bm5lci5sb2dcblxuICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgeyByZXR1cm4gMSB9XG4gIC4vcnVuLmNtZCAyPiYxIHwgT3V0LUZpbGUgLUVuY29kaW5nIEFTQ0lJIC1BcHBlbmQgL2FjdGlvbnMvcnVubmVyLmxvZ1xuICBpZiAoJExBU1RFWElUQ09ERSAtbmUgMCkgeyByZXR1cm4gMiB9XG5cbiAgJFNUQVRVUyA9IFNlbGVjdC1TdHJpbmcgLVBhdGggJy4vX2RpYWcvKi5sb2cnIC1QYXR0ZXJuICdmaW5pc2ggam9iIHJlcXVlc3QgZm9yIGpvYiBbMC05YS1mXFxcXC1dKyB3aXRoIHJlc3VsdDogKC4qKScgfCAleyRfLk1hdGNoZXMuR3JvdXBzWzFdLlZhbHVlfSB8IFNlbGVjdC1PYmplY3QgLUxhc3QgMVxuXG4gIGlmICgkU1RBVFVTKSB7XG4gICAgICBlY2hvIFwiQ0RLR0hBIEpPQiBET05FIFxcJHtsYWJlbHN9ICRTVEFUVVNcIiB8IE91dC1GaWxlIC1FbmNvZGluZyBBU0NJSSAtQXBwZW5kIC9hY3Rpb25zL3J1bm5lci5sb2dcbiAgfVxuXG4gIHJldHVybiAwXG59XG5zZXR1cF9sb2dzXG4kciA9IGFjdGlvblxuaWYgKCRyIC1lcSAwKSB7XG4gIGF3cyBzdGVwZnVuY3Rpb25zIHNlbmQtdGFzay1zdWNjZXNzIC0tdGFzay10b2tlbiBcIiRUQVNLX1RPS0VOXCIgLS10YXNrLW91dHB1dCAneyB9JyAyPiYxIHwgT3V0LUZpbGUgLUVuY29kaW5nIEFTQ0lJIC1BcHBlbmQgL2FjdGlvbnMvcnVubmVyLmxvZ1xufSBlbHNlIHtcbiAgYXdzIHN0ZXBmdW5jdGlvbnMgc2VuZC10YXNrLWZhaWx1cmUgLS10YXNrLXRva2VuIFwiJFRBU0tfVE9LRU5cIiAyPiYxIHwgT3V0LUZpbGUgLUVuY29kaW5nIEFTQ0lJIC1BcHBlbmQgL2FjdGlvbnMvcnVubmVyLmxvZ1xufVxuU3RhcnQtU2xlZXAgLVNlY29uZHMgMTAgICMgZ2l2ZSBjbG91ZHdhdGNoIGFnZW50IGl0cyBkZWZhdWx0IDUgc2Vjb25kcyBidWZmZXIgZHVyYXRpb24gdG8gdXBsb2FkIGxvZ3NcblN0b3AtQ29tcHV0ZXIgLUNvbXB1dGVyTmFtZSBsb2NhbGhvc3QgLUZvcmNlXG48L3Bvd2Vyc2hlbGw+XG5gLnJlcGxhY2UoL3svZywgJ1xcXFx7JykucmVwbGFjZSgvfS9nLCAnXFxcXH0nKS5yZXBsYWNlKC9cXFxce1xcXFx9L2csICd7fScpO1xuXG5cbi8qKlxuICogUHJvcGVydGllcyBmb3Ige0BsaW5rIEVjMlJ1bm5lclByb3ZpZGVyfSBjb25zdHJ1Y3QuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRWMyUnVubmVyUHJvdmlkZXJQcm9wcyBleHRlbmRzIFJ1bm5lclByb3ZpZGVyUHJvcHMge1xuICAvKipcbiAgICogUnVubmVyIGltYWdlIGJ1aWxkZXIgdXNlZCB0byBidWlsZCBBTUkgY29udGFpbmluZyBHaXRIdWIgUnVubmVyIGFuZCBhbGwgcmVxdWlyZW1lbnRzLlxuICAgKlxuICAgKiBUaGUgaW1hZ2UgYnVpbGRlciBkZXRlcm1pbmVzIHRoZSBPUyBhbmQgYXJjaGl0ZWN0dXJlIG9mIHRoZSBydW5uZXIuXG4gICAqXG4gICAqIEBkZWZhdWx0IEVjMlJ1bm5lclByb3ZpZGVyLmltYWdlQnVpbGRlcigpXG4gICAqL1xuICByZWFkb25seSBpbWFnZUJ1aWxkZXI/OiBJUnVubmVySW1hZ2VCdWlsZGVyO1xuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCB1c2UgaW1hZ2VCdWlsZGVyXG4gICAqL1xuICByZWFkb25seSBhbWlCdWlsZGVyPzogSVJ1bm5lckltYWdlQnVpbGRlcjtcblxuICAvKipcbiAgICogR2l0SHViIEFjdGlvbnMgbGFiZWxzIHVzZWQgZm9yIHRoaXMgcHJvdmlkZXIuXG4gICAqXG4gICAqIFRoZXNlIGxhYmVscyBhcmUgdXNlZCB0byBpZGVudGlmeSB3aGljaCBwcm92aWRlciBzaG91bGQgc3Bhd24gYSBuZXcgb24tZGVtYW5kIHJ1bm5lci4gRXZlcnkgam9iIHNlbmRzIGEgd2ViaG9vayB3aXRoIHRoZSBsYWJlbHMgaXQncyBsb29raW5nIGZvclxuICAgKiBiYXNlZCBvbiBydW5zLW9uLiBXZSBtYXRjaCB0aGUgbGFiZWxzIGZyb20gdGhlIHdlYmhvb2sgd2l0aCB0aGUgbGFiZWxzIHNwZWNpZmllZCBoZXJlLiBJZiBhbGwgdGhlIGxhYmVscyBzcGVjaWZpZWQgaGVyZSBhcmUgcHJlc2VudCBpbiB0aGVcbiAgICogam9iJ3MgbGFiZWxzLCB0aGlzIHByb3ZpZGVyIHdpbGwgYmUgY2hvc2VuIGFuZCBzcGF3biBhIG5ldyBydW5uZXIuXG4gICAqXG4gICAqIEBkZWZhdWx0IFsnZWMyJ11cbiAgICovXG4gIHJlYWRvbmx5IGxhYmVscz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBHaXRIdWIgQWN0aW9ucyBydW5uZXIgZ3JvdXAgbmFtZS5cbiAgICpcbiAgICogSWYgc3BlY2lmaWVkLCB0aGUgcnVubmVyIHdpbGwgYmUgcmVnaXN0ZXJlZCB3aXRoIHRoaXMgZ3JvdXAgbmFtZS4gU2V0dGluZyBhIHJ1bm5lciBncm91cCBjYW4gaGVscCBtYW5hZ2luZyBhY2Nlc3MgdG8gc2VsZi1ob3N0ZWQgcnVubmVycy4gSXRcbiAgICogcmVxdWlyZXMgYSBwYWlkIEdpdEh1YiBhY2NvdW50LlxuICAgKlxuICAgKiBUaGUgZ3JvdXAgbXVzdCBleGlzdCBvciB0aGUgcnVubmVyIHdpbGwgbm90IHN0YXJ0LlxuICAgKlxuICAgKiBVc2VycyB3aWxsIHN0aWxsIGJlIGFibGUgdG8gdHJpZ2dlciB0aGlzIHJ1bm5lciB3aXRoIHRoZSBjb3JyZWN0IGxhYmVscy4gQnV0IHRoZSBydW5uZXIgd2lsbCBvbmx5IGJlIGFibGUgdG8gcnVuIGpvYnMgZnJvbSByZXBvcyBhbGxvd2VkIHRvIHVzZSB0aGUgZ3JvdXAuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZ3JvdXA/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEluc3RhbmNlIHR5cGUgZm9yIGxhdW5jaGVkIHJ1bm5lciBpbnN0YW5jZXMuXG4gICAqXG4gICAqIEZvciBHUFUgaW5zdGFuY2UgdHlwZXMgKGc0ZG4sIGc1LCBwMywgZXRjLiksIHdlIGF1dG9tYXRpY2FsbHkgdXNlIGEgR1BVIGJhc2UgaW1hZ2UgKEFXUyBEZWVwIExlYXJuaW5nIEFNSSlcbiAgICogd2l0aCBOVklESUEgZHJpdmVycyBwcmUtaW5zdGFsbGVkLiBJZiB5b3UgcHJvdmlkZSB5b3VyIG93biBpbWFnZSBidWlsZGVyLCB1c2VcbiAgICogYGJhc2VBbWk6IEJhc2VJbWFnZS5mcm9tR3B1QmFzZShvcywgYXJjaGl0ZWN0dXJlKWAgb3IgYW5vdGhlciBpbWFnZSBwcmVsb2FkZWQgd2l0aCBOVklESUEgZHJpdmVycywgb3IgdXNlXG4gICAqIGFuIGltYWdlIGNvbXBvbmVudCB0byBpbnN0YWxsIE5WSURJQSBkcml2ZXJzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBtNmkubGFyZ2VcbiAgICovXG4gIHJlYWRvbmx5IGluc3RhbmNlVHlwZT86IGVjMi5JbnN0YW5jZVR5cGU7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBuZXN0ZWQgdmlydHVhbGl6YXRpb24gKEtWTS9IeXBlci1WKSBvbiBydW5uZXIgaW5zdGFuY2VzLlxuICAgKlxuICAgKiBUaGlzIG1hcHMgdG8gRUMyIGBDcHVPcHRpb25zLk5lc3RlZFZpcnR1YWxpemF0aW9uYC5cbiAgICpcbiAgICogTWFrZSBzdXJlIHRvIHVzZSBhbiBpbnN0YW5jZSB0eXBlIHRoYXQgc3VwcG9ydHMgbmVzdGVkIHZpcnR1YWxpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgLSBFQzIgZGVmYXVsdCBiZWhhdmlvclxuICAgKi9cbiAgcmVhZG9ubHkgbmVzdGVkVmlydHVhbGl6YXRpb24/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTaXplIG9mIHZvbHVtZSBhdmFpbGFibGUgZm9yIGxhdW5jaGVkIHJ1bm5lciBpbnN0YW5jZXMuIFRoaXMgbW9kaWZpZXMgdGhlIGJvb3Qgdm9sdW1lIHNpemUgYW5kIGRvZXNuJ3QgYWRkIGFueSBhZGRpdGlvbmFsIHZvbHVtZXMuXG4gICAqXG4gICAqIEBkZWZhdWx0IDMwR0JcbiAgICovXG4gIHJlYWRvbmx5IHN0b3JhZ2VTaXplPzogY2RrLlNpemU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbnMgZm9yIHJ1bm5lciBpbnN0YW5jZSBzdG9yYWdlIHZvbHVtZS5cbiAgICovXG4gIHJlYWRvbmx5IHN0b3JhZ2VPcHRpb25zPzogU3RvcmFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFNlY3VyaXR5IEdyb3VwIHRvIGFzc2lnbiB0byBsYXVuY2hlZCBydW5uZXIgaW5zdGFuY2VzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhIG5ldyBzZWN1cml0eSBncm91cFxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCB1c2Uge0BsaW5rIHNlY3VyaXR5R3JvdXBzfVxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cD86IGVjMi5JU2VjdXJpdHlHcm91cDtcblxuICAvKipcbiAgICogU2VjdXJpdHkgZ3JvdXBzIHRvIGFzc2lnbiB0byBsYXVuY2hlZCBydW5uZXIgaW5zdGFuY2VzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhIG5ldyBzZWN1cml0eSBncm91cFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcblxuICAvKipcbiAgICogU3VibmV0IHdoZXJlIHRoZSBydW5uZXIgaW5zdGFuY2VzIHdpbGwgYmUgbGF1bmNoZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IGRlZmF1bHQgc3VibmV0IG9mIGFjY291bnQncyBkZWZhdWx0IFZQQ1xuICAgKlxuICAgKiBAZGVwcmVjYXRlZCB1c2Uge0BsaW5rIHZwY30gYW5kIHtAbGluayBzdWJuZXRTZWxlY3Rpb259XG4gICAqL1xuICByZWFkb25seSBzdWJuZXQ/OiBlYzIuSVN1Ym5ldDtcblxuICAvKipcbiAgICogVlBDIHdoZXJlIHJ1bm5lciBpbnN0YW5jZXMgd2lsbCBiZSBsYXVuY2hlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgZGVmYXVsdCBhY2NvdW50IFZQQ1xuICAgKi9cbiAgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG5cbiAgLyoqXG4gICAqIFdoZXJlIHRvIHBsYWNlIHRoZSBuZXR3b3JrIGludGVyZmFjZXMgd2l0aGluIHRoZSBWUEMuIE9ubHkgdGhlIGZpcnN0IG1hdGNoZWQgc3VibmV0IHdpbGwgYmUgdXNlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgZGVmYXVsdCBWUEMgc3VibmV0XG4gICAqL1xuICByZWFkb25seSBzdWJuZXRTZWxlY3Rpb24/OiBlYzIuU3VibmV0U2VsZWN0aW9uO1xuXG4gIC8qKlxuICAgKiBVc2Ugc3BvdCBpbnN0YW5jZXMgdG8gc2F2ZSBtb25leS4gU3BvdCBpbnN0YW5jZXMgYXJlIGNoZWFwZXIgYnV0IG5vdCBhbHdheXMgYXZhaWxhYmxlIGFuZCBjYW4gYmUgc3RvcHBlZCBwcmVtYXR1cmVseS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHNwb3Q/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXQgYSBtYXhpbXVtIHByaWNlIGZvciBzcG90IGluc3RhbmNlcy5cbiAgICpcbiAgICogQGRlZmF1bHQgbm8gbWF4IHByaWNlICh5b3Ugd2lsbCBwYXkgY3VycmVudCBzcG90IHByaWNlKVxuICAgKi9cbiAgcmVhZG9ubHkgc3BvdE1heFByaWNlPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEdpdEh1YiBBY3Rpb25zIHJ1bm5lciBwcm92aWRlciB1c2luZyBFQzIgdG8gZXhlY3V0ZSBqb2JzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIG5vdCBtZWFudCB0byBiZSB1c2VkIGJ5IGl0c2VsZi4gSXQgc2hvdWxkIGJlIHBhc3NlZCBpbiB0aGUgcHJvdmlkZXJzIHByb3BlcnR5IGZvciBHaXRIdWJSdW5uZXJzLlxuICovXG5leHBvcnQgY2xhc3MgRWMyUnVubmVyUHJvdmlkZXIgZXh0ZW5kcyBCYXNlUHJvdmlkZXIgaW1wbGVtZW50cyBJUnVubmVyUHJvdmlkZXIge1xuICAvKipcbiAgICogQ3JlYXRlIG5ldyBpbWFnZSBidWlsZGVyIHRoYXQgYnVpbGRzIEVDMiBzcGVjaWZpYyBydW5uZXIgaW1hZ2VzLlxuICAgKlxuICAgKiBZb3UgY2FuIGN1c3RvbWl6ZSB0aGUgT1MsIGFyY2hpdGVjdHVyZSwgVlBDLCBzdWJuZXQsIHNlY3VyaXR5IGdyb3VwcywgZXRjLiBieSBwYXNzaW5nIGluIHByb3BzLlxuICAgKlxuICAgKiBZb3UgY2FuIGFkZCBjb21wb25lbnRzIHRvIHRoZSBpbWFnZSBidWlsZGVyIGJ5IGNhbGxpbmcgYGltYWdlQnVpbGRlci5hZGRDb21wb25lbnQoKWAuXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IE9TIGlzIFVidW50dSBydW5uaW5nIG9uIHg2NCBhcmNoaXRlY3R1cmUuXG4gICAqXG4gICAqIEluY2x1ZGVkIGNvbXBvbmVudHM6XG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5yZXF1aXJlZFBhY2thZ2VzKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5jbG91ZFdhdGNoQWdlbnQoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LnJ1bm5lclVzZXIoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdCgpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0aHViQ2xpKClgXG4gICAqICAqIGBSdW5uZXJJbWFnZUNvbXBvbmVudC5hd3NDbGkoKWBcbiAgICogICogYFJ1bm5lckltYWdlQ29tcG9uZW50LmRvY2tlcigpYFxuICAgKiAgKiBgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0aHViUnVubmVyKClgXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGltYWdlQnVpbGRlcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IFJ1bm5lckltYWdlQnVpbGRlclByb3BzKSB7XG4gICAgcmV0dXJuIFJ1bm5lckltYWdlQnVpbGRlci5uZXcoc2NvcGUsIGlkLCB7XG4gICAgICBvczogT3MuTElOVVhfVUJVTlRVLFxuICAgICAgYXJjaGl0ZWN0dXJlOiBBcmNoaXRlY3R1cmUuWDg2XzY0LFxuICAgICAgYnVpbGRlclR5cGU6IFJ1bm5lckltYWdlQnVpbGRlclR5cGUuQVdTX0lNQUdFX0JVSUxERVIsXG4gICAgICBjb21wb25lbnRzOiBbXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LnJlcXVpcmVkUGFja2FnZXMoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuY2xvdWRXYXRjaEFnZW50KCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LnJ1bm5lclVzZXIoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuZ2l0KCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YkNsaSgpLFxuICAgICAgICBSdW5uZXJJbWFnZUNvbXBvbmVudC5hd3NDbGkoKSxcbiAgICAgICAgUnVubmVySW1hZ2VDb21wb25lbnQuZG9ja2VyKCksXG4gICAgICAgIFJ1bm5lckltYWdlQ29tcG9uZW50LmdpdGh1YlJ1bm5lcihwcm9wcz8ucnVubmVyVmVyc2lvbiA/PyBSdW5uZXJWZXJzaW9uLmxhdGVzdCgpKSxcbiAgICAgIF0sXG4gICAgICAuLi5wcm9wcyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYWJlbHMgYXNzb2NpYXRlZCB3aXRoIHRoaXMgcHJvdmlkZXIuXG4gICAqL1xuICByZWFkb25seSBsYWJlbHM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBHcmFudCBwcmluY2lwYWwgdXNlZCB0byBhZGQgcGVybWlzc2lvbnMgdG8gdGhlIHJ1bm5lciByb2xlLlxuICAgKi9cbiAgcmVhZG9ubHkgZ3JhbnRQcmluY2lwYWw6IGlhbS5JUHJpbmNpcGFsO1xuXG4gIC8qKlxuICAgKiBMb2cgZ3JvdXAgd2hlcmUgcHJvdmlkZWQgcnVubmVycyB3aWxsIHNhdmUgdGhlaXIgbG9ncy5cbiAgICpcbiAgICogTm90ZSB0aGF0IHRoaXMgaXMgbm90IHRoZSBqb2IgbG9nLCBidXQgdGhlIHJ1bm5lciBpdHNlbGYuIEl0IHdpbGwgbm90IGNvbnRhaW4gb3V0cHV0IGZyb20gdGhlIEdpdEh1YiBBY3Rpb24gYnV0IG9ubHkgbWV0YWRhdGEgb24gaXRzIGV4ZWN1dGlvbi5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cDtcblxuICByZWFkb25seSByZXRyeWFibGVFcnJvcnMgPSBbXG4gICAgJ0VjMi5FYzJFeGNlcHRpb24nLFxuICAgICdTdGF0ZXMuVGltZW91dCcsXG4gIF07XG5cbiAgcHJpdmF0ZSByZWFkb25seSBncm91cD86IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBhbWlCdWlsZGVyOiBJUnVubmVySW1hZ2VCdWlsZGVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGFtaTogUnVubmVyQW1pO1xuICBwcml2YXRlIHJlYWRvbmx5IHJvbGU6IGlhbS5Sb2xlO1xuICBwcml2YXRlIHJlYWRvbmx5IGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZTtcbiAgcHJpdmF0ZSByZWFkb25seSBzdG9yYWdlU2l6ZTogY2RrLlNpemU7XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RvcmFnZU9wdGlvbnM/OiBTdG9yYWdlT3B0aW9ucztcbiAgcHJpdmF0ZSByZWFkb25seSBuZXN0ZWRWaXJ0dWFsaXphdGlvbj86IGJvb2xlYW47XG4gIHByaXZhdGUgcmVhZG9ubHkgc3BvdDogYm9vbGVhbjtcbiAgcHJpdmF0ZSByZWFkb25seSBzcG90TWF4UHJpY2U6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSByZWFkb25seSB2cGM6IGVjMi5JVnBjO1xuICBwcml2YXRlIHJlYWRvbmx5IHN1Ym5ldHM6IGVjMi5JU3VibmV0W107XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM6IGVjMi5JU2VjdXJpdHlHcm91cFtdO1xuICBwcml2YXRlIHJlYWRvbmx5IGRlZmF1bHRMYWJlbHM6IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBFYzJSdW5uZXJQcm92aWRlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICB0aGlzLmxhYmVscyA9IHByb3BzPy5sYWJlbHMgPz8gWydlYzInXTtcbiAgICB0aGlzLmdyb3VwID0gcHJvcHM/Lmdyb3VwO1xuICAgIHRoaXMudnBjID0gcHJvcHM/LnZwYyA/PyBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgJ0RlZmF1bHQgVlBDJywgeyBpc0RlZmF1bHQ6IHRydWUgfSk7XG4gICAgdGhpcy5zZWN1cml0eUdyb3VwcyA9IHByb3BzPy5zZWN1cml0eUdyb3VwID8gW3Byb3BzLnNlY3VyaXR5R3JvdXBdIDogKHByb3BzPy5zZWN1cml0eUdyb3VwcyA/PyBbbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdTRycsIHsgdnBjOiB0aGlzLnZwYyB9KV0pO1xuICAgIHRoaXMuc3VibmV0cyA9IHByb3BzPy5zdWJuZXQgPyBbcHJvcHMuc3VibmV0XSA6IHRoaXMudnBjLnNlbGVjdFN1Ym5ldHMocHJvcHM/LnN1Ym5ldFNlbGVjdGlvbikuc3VibmV0cztcbiAgICB0aGlzLmluc3RhbmNlVHlwZSA9IHByb3BzPy5pbnN0YW5jZVR5cGUgPz8gZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5NNkksIGVjMi5JbnN0YW5jZVNpemUuTEFSR0UpO1xuICAgIHRoaXMubmVzdGVkVmlydHVhbGl6YXRpb24gPSBwcm9wcz8ubmVzdGVkVmlydHVhbGl6YXRpb247XG4gICAgdGhpcy5zdG9yYWdlU2l6ZSA9IHByb3BzPy5zdG9yYWdlU2l6ZSA/PyBjZGsuU2l6ZS5naWJpYnl0ZXMoMzApOyAvLyAzMCBpcyB0aGUgbWluaW11bSBmb3IgV2luZG93c1xuICAgIHRoaXMuc3RvcmFnZU9wdGlvbnMgPSBwcm9wcz8uc3RvcmFnZU9wdGlvbnM7XG4gICAgdGhpcy5zcG90ID0gcHJvcHM/LnNwb3QgPz8gZmFsc2U7XG4gICAgdGhpcy5zcG90TWF4UHJpY2UgPSBwcm9wcz8uc3BvdE1heFByaWNlO1xuICAgIHRoaXMuZGVmYXVsdExhYmVscyA9IHByb3BzPy5kZWZhdWx0TGFiZWxzID8/IHRydWU7XG5cbiAgICBjb25zdCBhcmNoID0gdGhpcy5pbnN0YW5jZVR5cGUuYXJjaGl0ZWN0dXJlID09PSBlYzIuSW5zdGFuY2VBcmNoaXRlY3R1cmUuQVJNXzY0ID8gQXJjaGl0ZWN0dXJlLkFSTTY0IDogQXJjaGl0ZWN0dXJlLlg4Nl82NDtcblxuICAgIHRoaXMuYW1pQnVpbGRlciA9IHByb3BzPy5pbWFnZUJ1aWxkZXIgPz8gcHJvcHM/LmFtaUJ1aWxkZXIgPz8gRWMyUnVubmVyUHJvdmlkZXIuaW1hZ2VCdWlsZGVyKHRoaXMsICdBbWkgQnVpbGRlcicsIHtcbiAgICAgIHZwYzogcHJvcHM/LnZwYyxcbiAgICAgIHN1Ym5ldFNlbGVjdGlvbjogcHJvcHM/LnN1Ym5ldFNlbGVjdGlvbixcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiB0aGlzLnNlY3VyaXR5R3JvdXBzLFxuICAgICAgYmFzZUFtaTogaXNHcHVJbnN0YW5jZVR5cGUodGhpcy5pbnN0YW5jZVR5cGUpID8gQmFzZUltYWdlLmZyb21HcHVCYXNlKE9zLkxJTlVYX1VCVU5UVSwgYXJjaCkgOiB1bmRlZmluZWQsXG4gICAgICBhcmNoaXRlY3R1cmU6IGFyY2gsXG4gICAgICBhd3NJbWFnZUJ1aWxkZXJPcHRpb25zOiB7XG4gICAgICAgIGluc3RhbmNlVHlwZTogYXJjaC5pcyhBcmNoaXRlY3R1cmUuQVJNNjQpID8gZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5NNkcsIGVjMi5JbnN0YW5jZVNpemUuTEFSR0UpIDogdW5kZWZpbmVkLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB0aGlzLmFtaSA9IHRoaXMuYW1pQnVpbGRlci5iaW5kQW1pKCk7XG5cbiAgICBpZiAodGhpcy5hbWlCdWlsZGVyIGluc3RhbmNlb2YgQXdzSW1hZ2VCdWlsZGVyUnVubmVySW1hZ2VCdWlsZGVyKSB7XG4gICAgICBpZiAodGhpcy5hbWlCdWlsZGVyLnN0b3JhZ2VTaXplICYmIHRoaXMuc3RvcmFnZVNpemUudG9CeXRlcygpIDwgdGhpcy5hbWlCdWlsZGVyLnN0b3JhZ2VTaXplLnRvQnl0ZXMoKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJ1bm5lciBzdG9yYWdlIHNpemUgKCR7dGhpcy5zdG9yYWdlU2l6ZS50b0dpYmlieXRlcygpfSBHaUIpIG11c3QgYmUgYXQgbGVhc3QgdGhlIHNhbWUgYXMgdGhlIGltYWdlIGJ1aWxkZXIgc3RvcmFnZSBzaXplICgke3RoaXMuYW1pQnVpbGRlci5zdG9yYWdlU2l6ZS50b0dpYmlieXRlcygpfSBHaUIpYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmFtaS5hcmNoaXRlY3R1cmUuaW5zdGFuY2VUeXBlTWF0Y2godGhpcy5pbnN0YW5jZVR5cGUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFNSSBhcmNoaXRlY3R1cmUgKCR7dGhpcy5hbWkuYXJjaGl0ZWN0dXJlLm5hbWV9KSBkb2Vzbid0IG1hdGNoIHJ1bm5lciBpbnN0YW5jZSB0eXBlICgke3RoaXMuaW5zdGFuY2VUeXBlfSAvICR7dGhpcy5pbnN0YW5jZVR5cGUuYXJjaGl0ZWN0dXJlfSlgKTtcbiAgICB9XG5cbiAgICB0aGlzLmdyYW50UHJpbmNpcGFsID0gdGhpcy5yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2VjMi5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgdGhpcy5ncmFudFByaW5jaXBhbC5hZGRUb1ByaW5jaXBhbFBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3N0YXRlczpTZW5kVGFza0ZhaWx1cmUnLCAnc3RhdGVzOlNlbmRUYXNrU3VjY2VzcycsICdzdGF0ZXM6U2VuZFRhc2tIZWFydGJlYXQnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sIC8vIG5vIHN1cHBvcnQgZm9yIHN0YXRlTWFjaGluZS5zdGF0ZU1hY2hpbmVBcm4gYnV0IHRhc2sgdG9rZW5zIGFyZSB2ZXJ5IGxvbmcgYW5kIHRvdGFsbHkgcmFuZG9tIHNvIG5vdCB0aGUgZW5kIG9mIHRoZSB3b3JsZFxuICAgIH0pKTtcbiAgICB0aGlzLmdyYW50UHJpbmNpcGFsLmFkZFRvUHJpbmNpcGFsUG9saWN5KE1JTklNQUxfRUMyX1NTTV9TRVNTSU9OX01BTkFHRVJfUE9MSUNZX1NUQVRFTUVOVCk7XG5cbiAgICB0aGlzLmxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAoXG4gICAgICB0aGlzLFxuICAgICAgJ0xvZ3MnLFxuICAgICAge1xuICAgICAgICByZXRlbnRpb246IHByb3BzPy5sb2dSZXRlbnRpb24gPz8gUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICB0aGlzLmxvZ0dyb3VwLmdyYW50V3JpdGUodGhpcyk7XG4gIH1cblxuICAvKipcbiAgICogR2VuZXJhdGUgc3RlcCBmdW5jdGlvbiB0YXNrKHMpIHRvIHN0YXJ0IGEgbmV3IHJ1bm5lci5cbiAgICpcbiAgICogQ2FsbGVkIGJ5IEdpdGh1YlJ1bm5lcnMgYW5kIHNob3VsZG4ndCBiZSBjYWxsZWQgbWFudWFsbHkuXG4gICAqXG4gICAqIEBwYXJhbSBwYXJhbWV0ZXJzIHdvcmtmbG93IGpvYiBkZXRhaWxzXG4gICAqL1xuICBnZXRTdGVwRnVuY3Rpb25UYXNrKHBhcmFtZXRlcnM6IFJ1bm5lclJ1bnRpbWVQYXJhbWV0ZXJzKTogc3RlcGZ1bmN0aW9ucy5JQ2hhaW5hYmxlIHtcbiAgICAvLyB3ZSBuZWVkIHRvIGJ1aWxkIHVzZXIgZGF0YSBpbiB0d28gc3RlcHMgYmVjYXVzZSBwYXNzaW5nIHRoZSB0ZW1wbGF0ZSBhcyB0aGUgZmlyc3QgcGFyYW1ldGVyIHRvIHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguZm9ybWF0IGZhaWxzIG9uIHN5bnRheFxuXG4gICAgY29uc3QgcGFyYW1zID0gW1xuICAgICAgc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC50YXNrVG9rZW4sXG4gICAgICB0aGlzLmxvZ0dyb3VwLmxvZ0dyb3VwTmFtZSxcbiAgICAgIHBhcmFtZXRlcnMucnVubmVyTmFtZVBhdGgsXG4gICAgICBwYXJhbWV0ZXJzLmdpdGh1YkRvbWFpblBhdGgsXG4gICAgICBwYXJhbWV0ZXJzLm93bmVyUGF0aCxcbiAgICAgIHBhcmFtZXRlcnMucmVwb1BhdGgsXG4gICAgICBwYXJhbWV0ZXJzLnJ1bm5lclRva2VuUGF0aCxcbiAgICAgIHBhcmFtZXRlcnMubGFiZWxzUGF0aCxcbiAgICAgIHBhcmFtZXRlcnMucmVnaXN0cmF0aW9uVXJsLFxuICAgICAgdGhpcy5ncm91cCA/ICctLXJ1bm5lcmdyb3VwJyA6ICcnLFxuICAgICAgLy8gdGhpcyBpcyBzcGxpdCBpbnRvIDIgZm9yIHBvd2Vyc2hlbGwgb3RoZXJ3aXNlIGl0IHdpbGwgcGFzcyBcIi0tcnVubmVyZ3JvdXAgbmFtZVwiIGFzIGEgc2luZ2xlIGFyZ3VtZW50IGFuZCBjb25maWcuc2ggd2lsbCBmYWlsXG4gICAgICB0aGlzLmdyb3VwID8gdGhpcy5ncm91cCA6ICcnLFxuICAgICAgdGhpcy5kZWZhdWx0TGFiZWxzID8gJycgOiAnLS1uby1kZWZhdWx0LWxhYmVscycsXG4gICAgXTtcblxuICAgIGNvbnN0IHBhc3NVc2VyRGF0YSA9IG5ldyBzdGVwZnVuY3Rpb25zLlBhc3ModGhpcywgJ0RhdGEnLCB7XG4gICAgICBzdGF0ZU5hbWU6IGdlbmVyYXRlU3RhdGVOYW1lKHRoaXMsICdkYXRhJyksXG4gICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgIHVzZXJkYXRhVGVtcGxhdGU6IHRoaXMuYW1pLm9zLmlzKE9zLldJTkRPV1MpID8gd2luZG93c1VzZXJEYXRhVGVtcGxhdGUgOiBsaW51eFVzZXJEYXRhVGVtcGxhdGUsXG4gICAgICB9LFxuICAgICAgcmVzdWx0UGF0aDogc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5zdHJpbmdBdCgnJC5lYzInKSxcbiAgICB9KTtcblxuICAgIC8vIHdlIHVzZSBlYzI6UnVuSW5zdGFuY2VzIGJlY2F1c2Ugd2UgbXVzdFxuICAgIC8vIHdlIGNhbid0IHVzZSBmbGVldHMgYmVjYXVzZSB0aGV5IGRvbid0IGxldCB1cyBvdmVycmlkZSB1c2VyIGRhdGEsIHNlY3VyaXR5IGdyb3VwcyBvciBldmVuIGRpc2sgc2l6ZVxuICAgIC8vIHdlIGNhbid0IHVzZSByZXF1ZXN0U3BvdEluc3RhbmNlcyBiZWNhdXNlIGl0IGRvZXNuJ3Qgc3VwcG9ydCBsYXVuY2ggdGVtcGxhdGVzLCBhbmQgaXQncyBkZXByZWNhdGVkXG4gICAgLy8gZWMyOlJ1bkluc3RhbmNlcyBhbHNvIHNlZW1lZCBsaWtlIHRoZSBvbmx5IG9uZSB0byBpbW1lZGlhdGVseSByZXR1cm4gYW4gZXJyb3Igd2hlbiBzcG90IGNhcGFjaXR5IGlzIG5vdCBhdmFpbGFibGVcblxuICAgIC8vIHdlIGJ1aWxkIGEgY29tcGxpY2F0ZWQgY2hhaW4gb2Ygc3RhdGVzIGhlcmUgYmVjYXVzZSBlYzI6UnVuSW5zdGFuY2VzIGNhbiBvbmx5IHRyeSBvbmUgc3VibmV0IGF0IGEgdGltZVxuICAgIC8vIGlmIHNvbWVvbmUgY2FuIGZpZ3VyZSBvdXQgYSBnb29kIHdheSB0byB1c2UgTWFwIGZvciB0aGlzLCBwbGVhc2Ugb3BlbiBhIFBSXG5cbiAgICAvLyBidWlsZCBhIHN0YXRlIGZvciBlYWNoIHN1Ym5ldCB3ZSB3YW50IHRvIHRyeVxuICAgIGNvbnN0IGluc3RhbmNlUHJvZmlsZSA9IG5ldyBpYW0uQ2ZuSW5zdGFuY2VQcm9maWxlKHRoaXMsICdJbnN0YW5jZSBQcm9maWxlJywge1xuICAgICAgcm9sZXM6IFt0aGlzLnJvbGUucm9sZU5hbWVdLFxuICAgIH0pO1xuICAgIGNvbnN0IHJvb3REZXZpY2VSZXNvdXJjZSA9IGFtaVJvb3REZXZpY2UodGhpcywgdGhpcy5hbWkubGF1bmNoVGVtcGxhdGUubGF1bmNoVGVtcGxhdGVJZCk7XG4gICAgcm9vdERldmljZVJlc291cmNlLm5vZGUuYWRkRGVwZW5kZW5jeSh0aGlzLmFtaUJ1aWxkZXIpO1xuICAgIGNvbnN0IHN1Ym5ldFJ1bm5lcnMgPSB0aGlzLnN1Ym5ldHMubWFwKHN1Ym5ldCA9PiB7XG4gICAgICByZXR1cm4gbmV3IHN0ZXBmdW5jdGlvbnNfdGFza3MuQ2FsbEF3c1NlcnZpY2UodGhpcywgc3VibmV0LnN1Ym5ldElkLCB7XG4gICAgICAgIHN0YXRlTmFtZTogZ2VuZXJhdGVTdGF0ZU5hbWUodGhpcywgc3VibmV0LnN1Ym5ldElkKSxcbiAgICAgICAgY29tbWVudDogc3VibmV0LmF2YWlsYWJpbGl0eVpvbmUsXG4gICAgICAgIGludGVncmF0aW9uUGF0dGVybjogSW50ZWdyYXRpb25QYXR0ZXJuLldBSVRfRk9SX1RBU0tfVE9LRU4sXG4gICAgICAgIHNlcnZpY2U6ICdlYzInLFxuICAgICAgICBhY3Rpb246ICdydW5JbnN0YW5jZXMnLFxuICAgICAgICBoZWFydGJlYXRUaW1lb3V0OiBzdGVwZnVuY3Rpb25zLlRpbWVvdXQuZHVyYXRpb24oRHVyYXRpb24ubWludXRlcygxMCkpLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgTGF1bmNoVGVtcGxhdGU6IHtcbiAgICAgICAgICAgIExhdW5jaFRlbXBsYXRlSWQ6IHRoaXMuYW1pLmxhdW5jaFRlbXBsYXRlLmxhdW5jaFRlbXBsYXRlSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBNaW5Db3VudDogMSxcbiAgICAgICAgICBNYXhDb3VudDogMSxcbiAgICAgICAgICBJbnN0YW5jZVR5cGU6IHRoaXMuaW5zdGFuY2VUeXBlLnRvU3RyaW5nKCksXG4gICAgICAgICAgVXNlckRhdGE6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguYmFzZTY0RW5jb2RlKFxuICAgICAgICAgICAgc3RlcGZ1bmN0aW9ucy5Kc29uUGF0aC5mb3JtYXQoXG4gICAgICAgICAgICAgIHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQuZWMyLnVzZXJkYXRhVGVtcGxhdGUnKSxcbiAgICAgICAgICAgICAgLi4ucGFyYW1zLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApLFxuICAgICAgICAgIEluc3RhbmNlSW5pdGlhdGVkU2h1dGRvd25CZWhhdmlvcjogZWMyLkluc3RhbmNlSW5pdGlhdGVkU2h1dGRvd25CZWhhdmlvci5URVJNSU5BVEUsXG4gICAgICAgICAgSWFtSW5zdGFuY2VQcm9maWxlOiB7XG4gICAgICAgICAgICBBcm46IGluc3RhbmNlUHJvZmlsZS5hdHRyQXJuLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgTWV0YWRhdGFPcHRpb25zOiB7XG4gICAgICAgICAgICBIdHRwVG9rZW5zOiAncmVxdWlyZWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgQ3B1T3B0aW9uczogdGhpcy5uZXN0ZWRWaXJ0dWFsaXphdGlvbiA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDoge1xuICAgICAgICAgICAgTmVzdGVkVmlydHVhbGl6YXRpb246IHRoaXMubmVzdGVkVmlydHVhbGl6YXRpb24gPyAnZW5hYmxlZCcgOiAnZGlzYWJsZWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgU2VjdXJpdHlHcm91cElkczogdGhpcy5zZWN1cml0eUdyb3Vwcy5tYXAoc2cgPT4gc2cuc2VjdXJpdHlHcm91cElkKSxcbiAgICAgICAgICBTdWJuZXRJZDogc3VibmV0LnN1Ym5ldElkLFxuICAgICAgICAgIEJsb2NrRGV2aWNlTWFwcGluZ3M6IFt7XG4gICAgICAgICAgICBEZXZpY2VOYW1lOiByb290RGV2aWNlUmVzb3VyY2UucmVmLFxuICAgICAgICAgICAgRWJzOiB7XG4gICAgICAgICAgICAgIERlbGV0ZU9uVGVybWluYXRpb246IHRydWUsXG4gICAgICAgICAgICAgIFZvbHVtZVNpemU6IHRoaXMuc3RvcmFnZVNpemUudG9HaWJpYnl0ZXMoKSxcbiAgICAgICAgICAgICAgVm9sdW1lVHlwZTogdGhpcy5zdG9yYWdlT3B0aW9ucz8udm9sdW1lVHlwZSxcbiAgICAgICAgICAgICAgSW9wczogdGhpcy5zdG9yYWdlT3B0aW9ucz8uaW9wcyxcbiAgICAgICAgICAgICAgVGhyb3VnaHB1dDogdGhpcy5zdG9yYWdlT3B0aW9ucz8udGhyb3VnaHB1dCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfV0sXG4gICAgICAgICAgSW5zdGFuY2VNYXJrZXRPcHRpb25zOiB0aGlzLnNwb3QgPyB7XG4gICAgICAgICAgICBNYXJrZXRUeXBlOiAnc3BvdCcsXG4gICAgICAgICAgICBTcG90T3B0aW9uczoge1xuICAgICAgICAgICAgICBNYXhQcmljZTogdGhpcy5zcG90TWF4UHJpY2UsXG4gICAgICAgICAgICAgIFNwb3RJbnN0YW5jZVR5cGU6ICdvbmUtdGltZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0gOiB1bmRlZmluZWQsXG4gICAgICAgICAgVGFnU3BlY2lmaWNhdGlvbnM6IFsnaW5zdGFuY2UnLCAndm9sdW1lJ10ubWFwKHJlc1R5cGUgPT4geyAvLyBtYW51YWxseSBwcm9wYWdhdGUgdGFnc1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgUmVzb3VyY2VUeXBlOiByZXNUeXBlLFxuICAgICAgICAgICAgICBUYWdzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgS2V5OiAnTmFtZScsXG4gICAgICAgICAgICAgICAgICBWYWx1ZTogcGFyYW1ldGVycy5ydW5uZXJOYW1lUGF0aCxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIEtleTogJ0dpdEh1YlJ1bm5lcnM6UHJvdmlkZXInLFxuICAgICAgICAgICAgICAgICAgVmFsdWU6IHRoaXMubm9kZS5wYXRoLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgS2V5OiAnR2l0SHViUnVubmVyczpSZXBvJyxcbiAgICAgICAgICAgICAgICAgIFZhbHVlOiBzdGVwZnVuY3Rpb25zLkpzb25QYXRoLmZvcm1hdCgne30ve30nLCBwYXJhbWV0ZXJzLm93bmVyUGF0aCwgcGFyYW1ldGVycy5yZXBvUGF0aCksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICBLZXk6ICdHaXRIdWJSdW5uZXJzOkxhYmVscycsXG4gICAgICAgICAgICAgICAgICBWYWx1ZTogcGFyYW1ldGVycy5sYWJlbHNQYXRoLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgICBpYW1SZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBzdGFydCB3aXRoIHRoZSBmaXJzdCBzdWJuZXRcbiAgICBwYXNzVXNlckRhdGEubmV4dChzdWJuZXRSdW5uZXJzWzBdKTtcblxuICAgIC8vIGNoYWluIHVwIHRoZSByZXN0IG9mIHRoZSBzdWJuZXRzXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPCBzdWJuZXRSdW5uZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBzdWJuZXRSdW5uZXJzW2kgLSAxXS5hZGRDYXRjaChzdWJuZXRSdW5uZXJzW2ldLCB7XG4gICAgICAgIGVycm9yczogWydFYzIuRWMyRXhjZXB0aW9uJywgJ1N0YXRlcy5UaW1lb3V0J10sXG4gICAgICAgIHJlc3VsdFBhdGg6IHN0ZXBmdW5jdGlvbnMuSnNvblBhdGguc3RyaW5nQXQoJyQubGFzdFN1Ym5ldEVycm9yJyksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcGFzc1VzZXJEYXRhO1xuICB9XG5cbiAgZ3JhbnRTdGF0ZU1hY2hpbmUoc3RhdGVNYWNoaW5lUm9sZTogaWFtLklHcmFudGFibGUpIHtcbiAgICBzdGF0ZU1hY2hpbmVSb2xlLmdyYW50UHJpbmNpcGFsLmFkZFRvUHJpbmNpcGFsUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXG4gICAgICByZXNvdXJjZXM6IFt0aGlzLnJvbGUucm9sZUFybl0sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICdpYW06UGFzc2VkVG9TZXJ2aWNlJzogJ2VjMi5hbWF6b25hd3MuY29tJyxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgc3RhdGVNYWNoaW5lUm9sZS5ncmFudFByaW5jaXBhbC5hZGRUb1ByaW5jaXBhbFBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2VjMjpjcmVhdGVUYWdzJ10sXG4gICAgICByZXNvdXJjZXM6IFtTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgICBzZXJ2aWNlOiAnZWMyJyxcbiAgICAgICAgcmVzb3VyY2U6ICcqJyxcbiAgICAgIH0pXSxcbiAgICB9KSk7XG5cbiAgICBzdGF0ZU1hY2hpbmVSb2xlLmdyYW50UHJpbmNpcGFsLmFkZFRvUHJpbmNpcGFsUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnaWFtOkNyZWF0ZVNlcnZpY2VMaW5rZWRSb2xlJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgY29uZGl0aW9uczoge1xuICAgICAgICBTdHJpbmdFcXVhbHM6IHtcbiAgICAgICAgICAnaWFtOkFXU1NlcnZpY2VOYW1lJzogJ3Nwb3QuYW1hem9uYXdzLmNvbScsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pKTtcbiAgfVxuXG4gIHN0YXR1cyhzdGF0dXNGdW5jdGlvblJvbGU6IGlhbS5JR3JhbnRhYmxlKTogSVJ1bm5lclByb3ZpZGVyU3RhdHVzIHtcbiAgICBzdGF0dXNGdW5jdGlvblJvbGUuZ3JhbnRQcmluY2lwYWwuYWRkVG9QcmluY2lwYWxQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogWydlYzI6RGVzY3JpYmVMYXVuY2hUZW1wbGF0ZVZlcnNpb25zJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIHJldHVybiB7XG4gICAgICB0eXBlOiB0aGlzLmNvbnN0cnVjdG9yLm5hbWUsXG4gICAgICBsYWJlbHM6IHRoaXMubGFiZWxzLFxuICAgICAgY29uc3RydWN0UGF0aDogdGhpcy5ub2RlLnBhdGgsXG4gICAgICBzZWN1cml0eUdyb3VwczogdGhpcy5zZWN1cml0eUdyb3Vwcy5tYXAoc2cgPT4gc2cuc2VjdXJpdHlHcm91cElkKSxcbiAgICAgIHJvbGVBcm46IHRoaXMucm9sZS5yb2xlQXJuLFxuICAgICAgbG9nR3JvdXA6IHRoaXMubG9nR3JvdXAubG9nR3JvdXBOYW1lLFxuICAgICAgYW1pOiB7XG4gICAgICAgIGxhdW5jaFRlbXBsYXRlOiB0aGlzLmFtaS5sYXVuY2hUZW1wbGF0ZS5sYXVuY2hUZW1wbGF0ZUlkIHx8ICd1bmtub3duJyxcbiAgICAgICAgYW1pQnVpbGRlckxvZ0dyb3VwOiB0aGlzLmFtaS5sb2dHcm91cD8ubG9nR3JvdXBOYW1lLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBuZXR3b3JrIGNvbm5lY3Rpb25zIGFzc29jaWF0ZWQgd2l0aCB0aGlzIHJlc291cmNlLlxuICAgKi9cbiAgcHVibGljIGdldCBjb25uZWN0aW9ucygpOiBlYzIuQ29ubmVjdGlvbnMge1xuICAgIHJldHVybiBuZXcgZWMyLkNvbm5lY3Rpb25zKHsgc2VjdXJpdHlHcm91cHM6IHRoaXMuc2VjdXJpdHlHcm91cHMgfSk7XG4gIH1cbn1cblxuLyoqXG4gKiBAZGVwcmVjYXRlZCB1c2Uge0BsaW5rIEVjMlJ1bm5lclByb3ZpZGVyfVxuICovXG5leHBvcnQgY2xhc3MgRWMyUnVubmVyIGV4dGVuZHMgRWMyUnVubmVyUHJvdmlkZXIge1xufVxuIl19