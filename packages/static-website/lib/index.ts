import { CloudFrontToS3 } from "@aws-solutions-constructs/aws-cloudfront-s3";
import { CfnOutput, Duration } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { experimental, LambdaEdgeEventType } from "aws-cdk-lib/aws-cloudfront";
import { Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { HostedZone, ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, ISource } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from "constructs";

export type StaticWebsiteProps = {
  certificateARN: string,
  url: string,
  domainName: string,
  frontendSources: ISource[],
  basicAuth?: {
    username: string,
    password: string
  }
}

export class StaticWebsite extends Construct {
  distributionId: CfnOutput;

  constructor(scope: Construct, id: string, props: StaticWebsiteProps) {
    super(scope, id)

    const basicAuthLambda = props.basicAuth && new experimental.EdgeFunction(this, "BasicAuthLambda", {
      handler: "index.handler",
      runtime: Runtime.NODEJS_14_X,
      code: Code.fromInline(
        `
exports.handler = async (event, context, callback) => {

  const request = event.Records[0].cf.request;
  const headers = request.headers;

  const user = '${props.basicAuth.username}';
  const pass = '${props.basicAuth.password}';

  const basicAuthentication = 'Basic ' + new Buffer(user + ':' + pass).toString('base64');

  if (typeof headers.authorization == 'undefined' || headers.authorization[0].value != basicAuthentication) {
      const body = 'You are not authorized to enter';
      const response = {
          status: '401',
          statusDescription: 'Unauthorized',
          body: body,
          headers: {
              'www-authenticate': [{key: 'WWW-Authenticate', value:'Basic'}]
          },
      };
      callback(null, response);
  }
  callback(null, request);
};
        `
      )
    });

    const zone = HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    });

    const websiteBucket = new Bucket(this, 'WebsiteBucket')

    const edgeLambdas = basicAuthLambda
      ? [
      {
        functionVersion: basicAuthLambda.currentVersion,
        eventType: LambdaEdgeEventType.VIEWER_REQUEST,
      }
    ] : undefined

    const cloudfrontToS3 = new CloudFrontToS3(this, 'S3BackedCloudfront', {
      logS3AccessLogs: false,
      existingBucketObj: websiteBucket,
      insertHttpSecurityHeaders: false,
      cloudFrontDistributionProps: {
        comment: `Cloudfront distribution for the static website`,
        domainNames: [props.url],
        certificate: Certificate.fromCertificateArn(this, 'WebsiteCertificate', props.certificateARN),
        errorResponses: [
          {
            ttl: Duration.minutes(5),
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
          }
        ],
        defaultBehavior: {
          edgeLambdas,
        }
      }
    });

    new BucketDeployment(this, 'DeployWebsite', {
      sources: props.frontendSources,
      distribution: cloudfrontToS3.cloudFrontWebDistribution, // invalidates cloudfront cached files
      destinationBucket: websiteBucket,
    });

    new ARecord(this, "CloudfrontRecord", {
      recordName: props.url,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(cloudfrontToS3.cloudFrontWebDistribution)
      ),
      zone,
    });

    this.distributionId = new CfnOutput(this, 'DistributionID', {
      value: cloudfrontToS3.cloudFrontWebDistribution.distributionId
    })
  }
}
