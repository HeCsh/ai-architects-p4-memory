# The helper

This makes the **Add a news website** box work without leaving the site.

It is optional. Without it the box still works, it just asks you to confirm on
GitHub first. With it, you type an address, press the button, and that is the
whole thing.

## Why a helper is needed at all

Your site is only files sitting on a server. Files cannot change themselves.
Adding a news website means editing `config.json` in your project, and editing
your project needs a password.

That password cannot live in the page. Everything the page knows, every visitor
knows, because anyone can read a web page's code. A page that could edit your
project by itself would be a page handing out your password to strangers.

So the password lives here instead, on a small helper that runs on a server.
The page asks the helper to do the job. The helper holds the password, checks
the request is sensible, and makes the edit.

That split, a part people can see and a part that keeps the secrets, is how
almost every app with a login is built.

## Putting one up

About fifteen minutes. It costs nothing.

### 1. Make a GitHub password for it

A fine grained token, so it can only touch what it needs to.

1. GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens
2. Generate new token
3. Repository access: **Only select repositories**, and pick the course repositories
4. Permissions: Repository permissions, **Contents: Read and write**. Nothing else.
5. Generate, and copy it. GitHub shows it once.

### 2. Put the helper on Cloudflare

1. Sign up at cloudflare.com. The free plan is enough and needs no card.
2. Compute, Workers, Create application, Create Worker. Give it a name.
3. Deploy, then Edit code.
4. Replace everything there with the contents of `add-source-worker.js`.
5. Deploy again.

### 3. Give the helper the password

1. On the Worker: Settings, Variables and Secrets
2. Add a secret called `GITHUB_TOKEN`, paste the token in, save

The token is now stored where only the helper can read it. It is not in the
page, not in the project, and not in anything a visitor can see.

### 4. Tell your site where the helper is

Copy the Worker's address, which looks like
`https://something.your-name.workers.dev`, and add it to `config.json`:

```json
"addSourceHelper": "https://something.your-name.workers.dev"
```

That is it. The box now does the whole job on the page.

To turn it off again, delete that line. The box goes back to the confirm on
GitHub version.

## What the helper will and will not do

It is deliberately narrow, because a helper holding a password should only ever
do the one job it was built for.

- Only edits repositories belonging to the account named at the top of
  `add-source-worker.js`, whose name starts with `ai-architects-`. Change those
  two lines if your repositories are named differently.
- Only ever adds a news website to the `sources` list. It cannot change anything
  else in the project.
- Checks the address really has a news feed before saving anything.
- Refuses a website that is already on the list.
- Stops at eight websites.
- Will not touch addresses on a private network.

## If it stops working

- **"This helper has not been given a password yet."** The `GITHUB_TOKEN` secret
  is missing or misspelled. Step 3.
- **"GitHub said no (404)."** The token cannot see that repository. Check step 1,
  repository access.
- **"GitHub said no (403)."** The token is missing the Contents write permission,
  or it has expired. Fine grained tokens expire, so this is the usual cause after
  a few months.
- **"That project is not one this helper looks after."** The owner or repository
  name does not match the two settings at the top of `add-source-worker.js`.
