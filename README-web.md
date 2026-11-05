Before it works with your bucket, add this CORS rule in the S3 console (bucket → Permissions → CORS), with your site’s address in place of the example:


```
[
  {
    "AllowedOrigins": ["https://notes.example.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["authorization", "content-type", "content-md5", "x-amz-*", "if-match", "if-none-match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```