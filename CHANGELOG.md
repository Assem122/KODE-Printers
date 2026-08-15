# Change log

Newest last. One line per change.

1-Fixed docker-compose.yml failing to parse, which made every documented deployment command unrunnable
2-Fixed the container refusing to boot by adding DEPLOYMENT_TOPOLOGY, so the bind-host guard checks the right property per deployment
3-Fixed the converter sandbox passing a bubblewrap flag that does not exist, which silently disabled every document conversion
4-Fixed npm run migrate exiting successfully on Windows without applying any migration
5-Fixed manual job entries being recorded in the audit log as job retries
6-Fixed the first send retry waiting two minutes instead of the specified thirty seconds
7-Fixed printer access checks disagreeing about whether a disabled printer counts
8-Fixed the scan reservation lookup being readable without a grant on that printer
9-Fixed an audit log write attempt reporting itself as a printer deletion error
10-Fixed uploads being queued before the file was written, which failed valid jobs at random
11-Fixed text files containing Arabic or CJK being sent to printers unconverted
12-Fixed the PJL injection guard never running on any real job
13-Fixed scan filenames being broadcast over the live stream to users without access
14-Added walk-up attribution for printers behind a site collector, which recorded nothing before
15-Added the days-to-empty toner forecast to the fleet board, which was always blank
16-Changed the toner forecast to least squares over the retained history rather than its endpoints
17-Fixed the seeded admin password permanently blocking startup if the server restarted before it was changed
18-Changed startup to check configuration before touching the database, so a bad secret says so
19-Fixed the boot guard verifying every account password on every start
20-Added a compose file validation step to CI
21-Removed the test:e2e script, which called a Playwright binary the project does not install
22-Fixed jobs sent to collector-served printers retrying three times against an address the server cannot reach
23-Changed submission to refuse collector-served printers with a reason, since printing to them is not implemented
24-Added the eighteen undocumented endpoints to the API reference
25-Added a CI check that fails the build when the routes and the API reference disagree
26-Fixed jobs still being sent to a printer whose serial number no longer matches the record
27-Fixed npm run dev requiring environment variables to be exported by hand instead of reading .env
28-Fixed the fake-printer harness script pointing at a file that does not exist
29-Created the local development and test databases
30-Fixed the integration suite closing its database pool after the first test group, which failed every group after it
31-Fixed integration test files racing each other over the same test database
32-Fixed the API rejecting its own frontend when the dev server could not use its usual port
33-Fixed the seed banner describing startup behaviour that no longer applies
