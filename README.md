# LinkedIn Post Generator Automation (TechFix Pro)

This repository includes three Firebase Cloud Function workflows:

1. **`generateLinkedInPost`**: Generates a constrained LinkedIn post draft (hook, body, hashtags) and stores it in Firestore with `draft` status.
2. **`approveLinkedInPost`**: Human approval endpoint that marks a post as approved and scheduled.
3. **`publishScheduledLinkedInPosts` + `postInLinkedInNow`**: Automatic scheduled publishing and a manual “post now” endpoint.

## Firestore Collection

`posts/{id}` document fields:
- `service_name`
- `audience`
- `tone`
- `cta`
- `hook`
- `generated_post`
- `hashtags`
- `word_count`
- `status` (`draft`, `scheduled`, `published`, `failed`)
- `approval.approved`
- `approval.approved_by`
- `approval.approved_at`
- `scheduled_time`
- `published_at`
- `linkedin_post_urn`
- `error`

## Required Firebase Runtime Config

```bash
firebase functions:config:set openai.key="YOUR_OPENAI_API_KEY"
firebase functions:config:set linkedin.token="YOUR_LINKEDIN_ACCESS_TOKEN"
firebase functions:config:set linkedin.person_urn="urn:li:person:YOUR_PERSON_ID"
```

## Deploy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

## Endpoints

### 1) Generate Draft
`POST /generateLinkedInPost`

```json
{
  "serviceName": "TechFix Pro",
  "audience": "busy professionals, remote workers, and small business owners",
  "tone": "confident, professional, trustworthy",
  "cta": "Send us a message now and book your priority service.",
  "scheduledTime": "2026-04-01T10:00:00.000Z"
}
```

### 2) Approve + Schedule
`POST /approveLinkedInPost`

```json
{
  "postId": "FIRESTORE_DOC_ID",
  "approvedBy": "ops@techfixpro.com",
  "scheduledTime": "2026-04-01T10:00:00.000Z"
}
```

### 3) Post in LinkedIn Now
`POST /postInLinkedInNow`

```json
{
  "postId": "FIRESTORE_DOC_ID"
}
```

> `postInLinkedInNow` requires the post to already be approved.

## Publishing Behavior

The scheduled function runs every 15 minutes and publishes posts where:
- `status == "scheduled"`
- `approval.approved == true`
- `scheduled_time <= now`

On success, the post is marked `published`. On error, it is marked `failed` with an error message.
