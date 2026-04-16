FROM golang:1.24-alpine AS builder

RUN apk add --no-cache git gcc musl-dev
WORKDIR /src
RUN git clone --branch v1.2.2 --depth 1 https://github.com/barrydeen/haven.git .
RUN CGO_ENABLED=1 go build -ldflags="-s -w" -o /haven .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=builder /haven /usr/local/bin/haven
COPY --from=builder /src/templates /templates
WORKDIR /app
EXPOSE 3355
ENTRYPOINT ["haven"]
