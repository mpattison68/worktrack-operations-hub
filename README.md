# WorkTrack Operations Hub

Build WorkTrack using the attached WorkTrack_Lovable_Specification.md as the authoritative product and technical specification. Read the entire specification and preserve it in the project knowledge and repository. First produce an implementation plan covering increments A–F and the acceptance tests. Do not build a mock dashboard or attempt all functionality in one pass.

The production application must run on my own Linux VM using Docker Compose and self-hosted Supabase. Do not make Lovable Cloud a required production dependency. Use an independently controlled development backend with synthetic data. Connect to my private GitHub repository when available.

Implement increment A first: application foundation, authentication, permissions, job configuration, worker roles, rates, roster, database migrations and deployment skeleton. Provide actual test results and identify any limitations before proceeding to increment B.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0da5ad5f-daf4-42c1-ae48-02e7ef60d7c8).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
