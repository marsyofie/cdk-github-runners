import { StepFunctionLambdaInput } from './lambda-helpers';
export declare function handler(event: StepFunctionLambdaInput): Promise<{
    domain: string;
    token: string;
    registrationUrl: string;
}>;
