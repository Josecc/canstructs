import { CloudFrontToS3 } from "@aws-solutions-constructs/aws-cloudfront-s3";
import { CfnOutput, Duration } from "aws-cdk-lib";
import { Certificate, DnsValidatedCertificate } from "aws-cdk-lib/aws-certificatemanager";
import { DistributionProps, EdgeLambda, experimental, LambdaEdgeEventType } from "aws-cdk-lib/aws-cloudfront";
import { Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { HostedZone, ARecord, RecordTarget, PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, ISource } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from "constructs";

export type StaticWebsiteProps = {
  // TODO: clarify these names. url = domain name for website, where domainName is just
  // the name of the hosted zone in the account...
  url: string,
  domainName: string,
  frontendSources: ISource[],
  cloudfrontProps?: Partial<Omit<DistributionProps, "domainNames" | "certificate">>
  basicAuth?: {
    username: string,
    password: string
  }
  certificateARN?: string
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

    const basicAutEdgeLambda = basicAuthLambda
      ? 
        {
          functionVersion: basicAuthLambda.currentVersion,
          eventType: LambdaEdgeEventType.VIEWER_REQUEST,
        }
      : undefined

    const edgeLambdas = [...props.cloudfrontProps?.defaultBehavior?.edgeLambdas ?? [], basicAutEdgeLambda].filter(Boolean) 

    const certificate = props.certificateARN
      ? Certificate.fromCertificateArn(this, 'WebsiteCertificate', props.certificateARN)
      : new DnsValidatedCertificate(this, 'WebsiteCertificate', {
          domainName: props.url,
          hostedZone: zone,
        })

    const cloudfrontToS3 = new CloudFrontToS3(this, 'S3BackedCloudfront', {
      logS3AccessLogs: false,
      existingBucketObj: websiteBucket,
      insertHttpSecurityHeaders: false,
      cloudFrontDistributionProps: {
        comment: `Cloudfront distribution for the static website`,
        ...props.cloudfrontProps,
        domainNames: [props.url],
        certificate,
        defaultBehavior: {
          ...props.cloudfrontProps?.defaultBehavior,
          edgeLambdas: edgeLambdas.length > 0 ? edgeLambdas : undefined,
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
