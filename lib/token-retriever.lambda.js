"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const lambda_github_1 = require("./lambda-github");
class RunnerTokenError extends Error {
    constructor(msg) {
        super(msg);
        this.name = 'RunnerTokenError';
        Object.setPrototypeOf(this, RunnerTokenError.prototype);
    }
}
async function handler(event) {
    try {
        const { githubSecrets, octokit, } = await (0, lambda_github_1.getOctokit)(event.installationId);
        let token;
        let registrationUrl;
        if (githubSecrets.runnerLevel === 'repo' || githubSecrets.runnerLevel === undefined) {
            token = await getRegistrationTokenForRepo(octokit, event.owner, event.repo);
            registrationUrl = `https://${githubSecrets.domain}/${event.owner}/${event.repo}`;
        }
        else if (githubSecrets.runnerLevel === 'org') {
            token = await getRegistrationTokenForOrg(octokit, event.owner);
            registrationUrl = `https://${githubSecrets.domain}/${event.owner}`;
        }
        else {
            throw new RunnerTokenError('Invalid runner level');
        }
        return {
            domain: githubSecrets.domain,
            token,
            registrationUrl,
        };
    }
    catch (error) {
        console.error({
            notice: 'Failed to retrieve runner registration token',
            owner: event.owner,
            repo: event.repo,
            runnerName: event.runnerName,
            error: `${error}`,
        });
        throw new RunnerTokenError(error.message);
    }
}
async function getRegistrationTokenForOrg(octokit, owner) {
    const response = await octokit.rest.actions.createRegistrationTokenForOrg({
        org: owner,
    });
    return response.data.token;
}
async function getRegistrationTokenForRepo(octokit, owner, repo) {
    const response = await octokit.rest.actions.createRegistrationTokenForRepo({
        owner: owner,
        repo: repo,
    });
    return response.data.token;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidG9rZW4tcmV0cmlldmVyLmxhbWJkYS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy90b2tlbi1yZXRyaWV2ZXIubGFtYmRhLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBYUEsMEJBaUNDO0FBN0NELG1EQUE2QztBQUc3QyxNQUFNLGdCQUFpQixTQUFRLEtBQUs7SUFDbEMsWUFBWSxHQUFXO1FBQ3JCLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNYLElBQUksQ0FBQyxJQUFJLEdBQUcsa0JBQWtCLENBQUM7UUFDL0IsTUFBTSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDMUQsQ0FBQztDQUNGO0FBR00sS0FBSyxVQUFVLE9BQU8sQ0FBQyxLQUE4QjtJQUMxRCxJQUFJLENBQUM7UUFDSCxNQUFNLEVBQ0osYUFBYSxFQUNiLE9BQU8sR0FDUixHQUFHLE1BQU0sSUFBQSwwQkFBVSxFQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUUzQyxJQUFJLEtBQWEsQ0FBQztRQUNsQixJQUFJLGVBQXVCLENBQUM7UUFDNUIsSUFBSSxhQUFhLENBQUMsV0FBVyxLQUFLLE1BQU0sSUFBSSxhQUFhLENBQUMsV0FBVyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3BGLEtBQUssR0FBRyxNQUFNLDJCQUEyQixDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM1RSxlQUFlLEdBQUcsV0FBVyxhQUFhLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ25GLENBQUM7YUFBTSxJQUFJLGFBQWEsQ0FBQyxXQUFXLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDL0MsS0FBSyxHQUFHLE1BQU0sMEJBQTBCLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUMvRCxlQUFlLEdBQUcsV0FBVyxhQUFhLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNyRSxDQUFDO2FBQU0sQ0FBQztZQUNOLE1BQU0sSUFBSSxnQkFBZ0IsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO1FBQ3JELENBQUM7UUFDRCxPQUFPO1lBQ0wsTUFBTSxFQUFFLGFBQWEsQ0FBQyxNQUFNO1lBQzVCLEtBQUs7WUFDTCxlQUFlO1NBQ2hCLENBQUM7SUFDSixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sQ0FBQyxLQUFLLENBQUM7WUFDWixNQUFNLEVBQUUsOENBQThDO1lBQ3RELEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztZQUNsQixJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1lBQzVCLEtBQUssRUFBRSxHQUFHLEtBQUssRUFBRTtTQUNsQixDQUFDLENBQUM7UUFDSCxNQUFNLElBQUksZ0JBQWdCLENBQVMsS0FBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3JELENBQUM7QUFDSCxDQUFDO0FBQ0QsS0FBSyxVQUFVLDBCQUEwQixDQUFDLE9BQWdCLEVBQUUsS0FBYTtJQUN2RSxNQUFNLFFBQVEsR0FBRyxNQUFNLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLDZCQUE2QixDQUFDO1FBQ3hFLEdBQUcsRUFBRSxLQUFLO0tBQ1gsQ0FBQyxDQUFDO0lBQ0gsT0FBTyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztBQUM3QixDQUFDO0FBRUQsS0FBSyxVQUFVLDJCQUEyQixDQUFDLE9BQWdCLEVBQUUsS0FBYSxFQUFFLElBQVk7SUFDdEYsTUFBTSxRQUFRLEdBQUcsTUFBTSxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyw4QkFBOEIsQ0FBQztRQUN6RSxLQUFLLEVBQUUsS0FBSztRQUNaLElBQUksRUFBRSxJQUFJO0tBQ1gsQ0FBQyxDQUFDO0lBQ0gsT0FBTyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztBQUM3QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBPY3Rva2l0IH0gZnJvbSAnQG9jdG9raXQvcmVzdCc7XG5pbXBvcnQgeyBnZXRPY3Rva2l0IH0gZnJvbSAnLi9sYW1iZGEtZ2l0aHViJztcbmltcG9ydCB7IFN0ZXBGdW5jdGlvbkxhbWJkYUlucHV0IH0gZnJvbSAnLi9sYW1iZGEtaGVscGVycyc7XG5cbmNsYXNzIFJ1bm5lclRva2VuRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1zZzogc3RyaW5nKSB7XG4gICAgc3VwZXIobXNnKTtcbiAgICB0aGlzLm5hbWUgPSAnUnVubmVyVG9rZW5FcnJvcic7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHRoaXMsIFJ1bm5lclRva2VuRXJyb3IucHJvdG90eXBlKTtcbiAgfVxufVxuXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50OiBTdGVwRnVuY3Rpb25MYW1iZGFJbnB1dCkge1xuICB0cnkge1xuICAgIGNvbnN0IHtcbiAgICAgIGdpdGh1YlNlY3JldHMsXG4gICAgICBvY3Rva2l0LFxuICAgIH0gPSBhd2FpdCBnZXRPY3Rva2l0KGV2ZW50Lmluc3RhbGxhdGlvbklkKTtcblxuICAgIGxldCB0b2tlbjogc3RyaW5nO1xuICAgIGxldCByZWdpc3RyYXRpb25Vcmw6IHN0cmluZztcbiAgICBpZiAoZ2l0aHViU2VjcmV0cy5ydW5uZXJMZXZlbCA9PT0gJ3JlcG8nIHx8IGdpdGh1YlNlY3JldHMucnVubmVyTGV2ZWwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdG9rZW4gPSBhd2FpdCBnZXRSZWdpc3RyYXRpb25Ub2tlbkZvclJlcG8ob2N0b2tpdCwgZXZlbnQub3duZXIsIGV2ZW50LnJlcG8pO1xuICAgICAgcmVnaXN0cmF0aW9uVXJsID0gYGh0dHBzOi8vJHtnaXRodWJTZWNyZXRzLmRvbWFpbn0vJHtldmVudC5vd25lcn0vJHtldmVudC5yZXBvfWA7XG4gICAgfSBlbHNlIGlmIChnaXRodWJTZWNyZXRzLnJ1bm5lckxldmVsID09PSAnb3JnJykge1xuICAgICAgdG9rZW4gPSBhd2FpdCBnZXRSZWdpc3RyYXRpb25Ub2tlbkZvck9yZyhvY3Rva2l0LCBldmVudC5vd25lcik7XG4gICAgICByZWdpc3RyYXRpb25VcmwgPSBgaHR0cHM6Ly8ke2dpdGh1YlNlY3JldHMuZG9tYWlufS8ke2V2ZW50Lm93bmVyfWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBSdW5uZXJUb2tlbkVycm9yKCdJbnZhbGlkIHJ1bm5lciBsZXZlbCcpO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgZG9tYWluOiBnaXRodWJTZWNyZXRzLmRvbWFpbixcbiAgICAgIHRva2VuLFxuICAgICAgcmVnaXN0cmF0aW9uVXJsLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcih7XG4gICAgICBub3RpY2U6ICdGYWlsZWQgdG8gcmV0cmlldmUgcnVubmVyIHJlZ2lzdHJhdGlvbiB0b2tlbicsXG4gICAgICBvd25lcjogZXZlbnQub3duZXIsXG4gICAgICByZXBvOiBldmVudC5yZXBvLFxuICAgICAgcnVubmVyTmFtZTogZXZlbnQucnVubmVyTmFtZSxcbiAgICAgIGVycm9yOiBgJHtlcnJvcn1gLFxuICAgIH0pO1xuICAgIHRocm93IG5ldyBSdW5uZXJUb2tlbkVycm9yKCg8RXJyb3I+ZXJyb3IpLm1lc3NhZ2UpO1xuICB9XG59XG5hc3luYyBmdW5jdGlvbiBnZXRSZWdpc3RyYXRpb25Ub2tlbkZvck9yZyhvY3Rva2l0OiBPY3Rva2l0LCBvd25lcjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvY3Rva2l0LnJlc3QuYWN0aW9ucy5jcmVhdGVSZWdpc3RyYXRpb25Ub2tlbkZvck9yZyh7XG4gICAgb3JnOiBvd25lcixcbiAgfSk7XG4gIHJldHVybiByZXNwb25zZS5kYXRhLnRva2VuO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRSZWdpc3RyYXRpb25Ub2tlbkZvclJlcG8ob2N0b2tpdDogT2N0b2tpdCwgb3duZXI6IHN0cmluZywgcmVwbzogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBvY3Rva2l0LnJlc3QuYWN0aW9ucy5jcmVhdGVSZWdpc3RyYXRpb25Ub2tlbkZvclJlcG8oe1xuICAgIG93bmVyOiBvd25lcixcbiAgICByZXBvOiByZXBvLFxuICB9KTtcbiAgcmV0dXJuIHJlc3BvbnNlLmRhdGEudG9rZW47XG59XG4iXX0=