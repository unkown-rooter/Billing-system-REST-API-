Security Policy

Supported Versions

Security fixes are currently provided for the latest stable release of the Billing System REST API.

Version| Supported
1.0.x| :white_check_mark:
< 1.0| :x:

Security support may change as new major versions are released.

Reporting a Vulnerability

If you discover a security vulnerability in the Billing System REST API, please do not open a public GitHub issue.

Instead, report the vulnerability privately through the security contact or private vulnerability reporting mechanism provided by this repository.

When reporting a vulnerability, please include:

- A clear description of the vulnerability
- The affected API endpoint, component, or version
- Steps to reproduce the issue
- The potential security impact
- Any relevant request/response examples
- A suggested mitigation, if you have one

Please do not include passwords, authentication tokens, database credentials, API keys, or other sensitive information in the report.

What to Expect

After receiving a vulnerability report, the maintainers will:

1. Acknowledge receipt of the report.
2. Review and reproduce the reported issue where possible.
3. Determine its security impact and affected versions.
4. Work on an appropriate fix or mitigation.
5. Release a security update when necessary.
6. Update the reporter when there is meaningful progress.

Response times may vary depending on the severity and complexity of the vulnerability.

Responsible Disclosure

Please allow reasonable time for the vulnerability to be investigated and, where necessary, fixed before publicly disclosing technical details.

Security researchers who report vulnerabilities responsibly are appreciated and will be credited when appropriate, unless they prefer to remain anonymous.

Security Scope

This project is a billing management REST API.

Security reports may include issues involving:

- Authentication and authorization
- Account and customer access control
- IDOR and cross-account access
- JWT authentication
- Password handling
- SQL injection
- Input validation
- Sensitive information exposure
- API rate limiting
- Security headers and CORS
- Database access
- Invoice and invoice-item access control
- Privilege escalation
- Container or deployment security

Out of Scope

The following are generally outside the scope of this project's application security policy:

- Vulnerabilities in third-party services or infrastructure that are not caused by this project
- Denial-of-service attacks against public infrastructure
- Social engineering or phishing
- Physical attacks
- Automated scanning that creates excessive traffic
- Issues requiring compromised developer machines, hosting accounts, or credentials
- Vulnerabilities in unsupported versions

Please avoid testing against production systems in a way that could disrupt service or affect other users.

Security Best Practices for Users

Developers deploying this API should:

- Use a strong production JWT secret.
- Store secrets in environment variables or a secure secret-management system.
- Never commit ".env" files or credentials to Git.
- Use HTTPS in production.
- Use a dedicated production PostgreSQL database.
- Keep Node.js, PostgreSQL, Docker, and dependencies updated.
- Apply database migrations carefully.
- Restrict CORS to trusted origins where applicable.
- Protect database credentials.
- Monitor application and database logs for suspicious activity.
- Never expose authentication tokens, passwords, password hashes, or database credentials in logs or API responses.

Security Updates

Security fixes will be documented through the project's release history and changelog when appropriate.

For critical vulnerabilities, a security release may be published without immediately disclosing all technical details of the vulnerability in order to give users reasonable time to update.
