const nodemailer = require('nodemailer')

// const transporter = nodemailer.createTransport({
  
//   service: 'gmail',
//   auth: {
//     user: process.env.EMAIL_USER,
//     pass: process.env.EMAIL_PASS
//   }
// })
// transporter.verify((error, success) => {
//   if (error) {
//     console.log("SMTP ERROR:", error)
//   } else {
//     console.log("SMTP READY")
//   }
// })
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  connectionTimeout: 10000
})

const sendInviteEmail = async (toEmail, inviteLink) => {
      // console.log("EMAIL_USER:", process.env.EMAIL_USER)
      // console.log("EMAIL_PASS exists:", !!process.env.EMAIL_PASS)
      // console.log("Sending mail to:", toEmail)
  const mailOptions = {
    from: `"Varadhi Club" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'You are invited to Varadhi Tracker',
    html: `
      <h2>Welcome to Varadhi Tracker</h2>
      <p>You have been invited to join Varadhi Tracker.</p>
      <p>Click the button below to setup your account:</p>
        <a href="${inviteLink}"
     style="
       display:inline-block;
       padding:12px 24px;
       background:#7c3aed;
       color:white;
       text-decoration:none;
       border-radius:8px;
       font-weight:bold;
     ">
     Accept Invitation
  </a>
    `
  }

  await transporter.sendMail(mailOptions)
// const info = await transporter.sendMail(mailOptions)
// console.log("MAIL SENT:", info)
}

const sendResetEmail = async (toEmail, resetLink) => {
  const mailOptions = {
    from: `"Varadhi Club" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Varadhi Tracker password',
    html: `
      <h2>Reset your password</h2>
      <p>We received a request to reset the password for this account.</p>
      <p>Click the button below to choose a new password:</p>
        <a href="${resetLink}"
     style="
       display:inline-block;
       padding:12px 24px;
       background:#7c3aed;
       color:white;
       text-decoration:none;
       border-radius:8px;
       font-weight:bold;
     ">
     Reset Password
  </a>
      <p style="margin-top:24px;color:#64748b;font-size:13px;">
        This link expires in 1 hour. If you didn't request a reset, you can
        ignore this email &mdash; your password stays unchanged.
      </p>
    `
  }

  await transporter.sendMail(mailOptions)
}

module.exports = { sendInviteEmail, sendResetEmail }
