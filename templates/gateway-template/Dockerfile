FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /x402-gateway .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /x402-gateway /usr/local/bin/x402-gateway
EXPOSE 8402
ENTRYPOINT ["x402-gateway"]
