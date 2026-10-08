# Reviewed predecessor fixture

These before-images are the changed Megin/MergeReviewer files from the previously
bundled 0.13.2 workflow kit (payload
`11e66d6bf395cd0940fe2fd9c6aea4b403addde44dc7f241195b6ba52f7d3978`).
Their hashes are frozen in `resources/workflow-kit/trusted-predecessors.json`.
Release tests combine them with unchanged current bundle files to recreate the
complete predecessor, then exercise same-version upgrade and transaction rollback.
No business repositories, Work records or user installation journals are included.
