# Validation Proxy

Unlike mocking, the validation proxy expects there to be a real API running somewhere. This could be a localhost environment, docker container, hosted sandbox environment, or a production environment.

The proxy feature will help you identify discrepancies between the OpenAPI document and any other server you designate as the target. This can help frontend developers integrating with your API, or other backend developers, who might want to channel their requests through Prism to see if they're making valid requests. The proxy can also be enabled in staging or any other pre-production environment, like a dress rehearsal before the opening night of a play.

## Use Cases

### Assisting API Consumer Integration

In the [design-first workflow](https://blog.stoplight.io/api-first-api-design-first-or-code-first-which-should-you-choose), mocking gives your team something to use before the API exists. Then, when enough feedback has come in and the API developers have decided to start coding the API, the hope is that the real API matches the mock API. If it matches, the existing development work done by the API consumers during the feedback stage means that integrating the real API should involve little to no work. Sadly, subtle differences often go unnoticed, with properties changing slightly, or being removed completely.

API consumers can funnel their development traffic through Prism running as proxy, and then relay that traffic to the API-in-progress. It reports any mistakes it notices along the way, either with the requests you're sending or the responses coming back from the server.

In this use case, the OpenAPI documents are provided by the API team, distributed to the API consumers, and the proxy server points to the development environment. Also, enable `--errors` so Prism alerts you if a mismatch is noticed.

```bash
prism proxy reference/backend/openapi.yaml http://localhost:3000 --errors
```

> The proxy URL must begin with the protocol (`http`, `https`).

### End-to-End Contract Testing

Before the design-first workflow, folks would often slap together their own API descriptions, often by hand, and often just eyeball it for correctness. Various tools came and went for trying to test the correctness of their API description documents, but they were often awkward flaky test-suites that people ended just turning off. Adding contract testing to existing test-suites is now easy with Prism.

Teams with existing end-to-end test suites can drop Prism into this testing environment, and change some environment variables (or service catalog) to point to Prism Proxy. Each time API A talks to API B, or B to C, it will be going via C, so if any of the APIs make an invalid request the whole test suite can fail.

```bash
prism proxy reference/api-a/openapi.yaml api-a-test.example.com --errors -p 5000
prism proxy reference/api-b/openapi.yaml api-b-test.example.com --errors -p 5001
prism proxy reference/api-c/openapi.yaml api-c-test.example.com --errors -p 5002
```

This adds contract testing to an existing test suite, regardless of the language your APIs are written in, without any changes required to the codebases.

### Unimplemented Operations will be Mocked

In case the upstream server responds with the `501` status code, Prism will try to mock the call using the provided OpenAPI document.

### Live Contract Testing

Now you can use Prism to test traffic against the API description. This could be done in development, but it could also be placed in staging, QA, or some sort of pre-production environment. Probably keep it out of production, because even though Prism is quick like a fox, introducing _anything_ to the critical path of your API is probably not what you want.

### Deprecating operations

If an operation is marked as `deprecated: true`, Prism adds `Deprecation: true` header to the response if the response from remote server doesn't already contains that header.

<!-- theme:info -->

> Future versions of Prism will include ways to sniff existing traffic, without requests being made directly to it, such as sniffing NGINX logs, or piping other forms of traffic through. [Get in touch with ideas](https://github.com/stoplightio/prism/issues/955).
